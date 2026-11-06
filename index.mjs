// ring-lite: a small client for Ring cameras, with no dependencies beyond Node's built-ins.
//
// Ring has no public API. This speaks the private one Ring's own apps use, as worked out by the open-source
// ring-client-api (MIT, https://github.com/dgreif/ring). It is not affiliated with or endorsed by Ring or Amazon,
// and Ring can change that API at any time.
//
// It only ever talks to these hosts, all over HTTPS:
//   oauth.ring.com         sign-in, and swapping the refresh token for an hour's access token
//   api.ring.com           cameras, events, controls, live view, and the links to pictures and clips
//   app-snaps.ring.com     camera snapshots
//   *.devices.amazon.dev   Ring's video storage, through pre-signed links from api.ring.com. No token is sent there:
//                          it copies a request's headers into the link it redirects to.
//
// It doesn't sign up for Google push, subscribe cameras to anything or open any ports. Live view is relayed as
// WebRTC SDP: your browser (or any WebRTC stack) makes the offer, Ring answers, and the video goes between them.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OAUTH_URL = "https://oauth.ring.com/oauth/token";
const API_URL = "https://api.ring.com/";
const SNAPSHOT_URL = "https://app-snaps.ring.com/snapshots/next/";
// Ring's sign-in only takes its own apps' client id, so every Ring integration signs in as the Android app does.
const CLIENT_ID = "ring_official_android";
const USER_AGENT = "android:com.ringapp";
const MEDIA_HOST = /(^|\.)devices\.amazon\.dev$/;

const SESSION_MS = 12 * 3_600_000; // how often the client's entry in Ring's Control Center is renewed
const CAMERAS_MS = 5 * 60_000; // how often watchEvents() re-reads the camera list
export const LIVE_VIEW_MAX_MS = 10 * 60_000; // Ring ends a live view after about 10 minutes
const THUMBNAIL_MAX = 2 * 1024 * 1024;
const CLIP_MAX = 80 * 1024 * 1024; // Ring's clips are a few MB

const enc = encodeURIComponent;

export class RingError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.status = status;
  }
}

// The saved sign-in is missing (signedOut) or Ring refused it: a person has to sign in again.
export class SignInError extends RingError {
  constructor(message, { status, signedOut = false } = {}) {
    super(message, { status });
    this.signedOut = signedOut;
  }
}

// --- the saved sign-in --------------------------------------------------------------------------------------------

// Where ring-lite-signin saves the sign-in unless told otherwise.
export function defaultTokenFile() {
  const base = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
    : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "ring-lite", "ring-token.json");
}

// Makes a file readable and writable by the current user only.
async function lockToOwner(file) {
  if (process.platform !== "win32") return chmod(file, 0o600);
  const user = process.env.USERNAME;
  if (!user) throw new RingError("USERNAME isn't set, so the token file can't be locked to you");
  await new Promise((resolve, reject) =>
    execFile("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { windowsHide: true, timeout: 10_000 },
      (error) => (error ? reject(error) : resolve()))
  );
}

// A token store keeps the sign-in between runs. Ring swaps the refresh token at every refresh, so write() must
// really save it: a store that forgets is signed out within the hour.
// This one is a JSON file, locked to the current user before anything goes in it, and replaced whole on each write.
// It's re-read before every refresh, so several processes can share one file without spending a stale token.
export function fileTokenStore(file = defaultTokenFile()) {
  return {
    file,
    async read() {
      try {
        const t = JSON.parse(await readFile(file, "utf8"));
        return t?.refreshToken && t?.hardwareId ? t : null;
      } catch (e) {
        if (e.code === "ENOENT" || e instanceof SyntaxError) return null;
        throw e;
      }
    },
    async write(token) {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await rm(tmp, { force: true });
      await writeFile(tmp, "", { mode: 0o600 });
      await lockToOwner(tmp);
      await writeFile(tmp, JSON.stringify(token, null, 2));
      await rename(tmp, file); // keeps the lock
    },
  };
}

// One call to Ring's sign-in. grant is { grant_type: "password", username, password } or
// { grant_type: "refresh_token", refresh_token }. Answers { status, body }: 200 with tokens, or 412 when Ring wants
// a 2-step code (body.tsv_state says how it sent one, body.phone where).
export async function requestToken(grant, { hardwareId, code = "", fetch = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "2fa-support": "true",
      "2fa-code": code,
      hardware_id: hardwareId,
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "client", ...grant }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function tokenFrom(body, previous) {
  return {
    ...previous,
    refreshToken: body.refresh_token || previous.refreshToken,
    accessToken: body.access_token,
    accessExpiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
}

// Signs in with an email and password. askCode({ method, phone, attempt }) is called when Ring sends a 2-step code
// ("sms", "email" or "totp" for an authenticator app) and answers with the code; three tries. Answers the token to
// save: { refreshToken, hardwareId, accessToken, accessExpiresAt, signedInAt }. Keep hardwareId the same on a later
// sign-in, so Ring sees the same device.
export async function signInWithPassword({ email, password, askCode, hardwareId = randomUUID(), fetch = globalThis.fetch }) {
  const grant = { grant_type: "password", username: email, password };
  let r = await requestToken(grant, { hardwareId, fetch });
  if (r.status === 412) {
    if (!askCode) throw new SignInError("Ring wants a 2-step code, and no askCode was given", { status: 412 });
    const challenge = { method: r.body?.tsv_state ?? null, phone: r.body?.phone ?? null };
    for (let attempt = 0; attempt < 3 && r.status !== 200; attempt++) {
      const code = String(await askCode({ ...challenge, attempt })).trim();
      r = await requestToken(grant, { hardwareId, code, fetch });
      if (r.status !== 200 && !(r.status === 400 && /^Verification Code/i.test(String(r.body?.error)))) break;
    }
  }
  if (r.status !== 200 || !r.body?.access_token) {
    const why = r.body?.error_description || r.body?.error || `HTTP ${r.status}`;
    throw new SignInError(/too many requests/i.test(String(r.body?.error_description))
      ? "Ring allows 10 codes in 10 minutes; wait 10 minutes and try again"
      : `Ring didn't sign in (${why})`, { status: r.status });
  }
  return { ...tokenFrom(r.body, { hardwareId }), signedInAt: new Date().toISOString() };
}

// --- what Ring sends ----------------------------------------------------------------------------------------------

// Doorbells and cameras on the account, from Ring's ring_devices answer.
export function parseCameras(data) {
  return [...(data?.doorbots ?? []), ...(data?.authorized_doorbots ?? []), ...(data?.stickup_cams ?? [])].map((d) => {
    const level = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    const levels = [level(d.battery_life), level(d.battery_life_2)].filter((v) => v !== null);
    const battery = levels.length ? Math.min(...levels) : null;
    return {
      id: String(d.id),
      deviceId: d.id, // as Ring sent it, for live view
      locationId: d.location_id == null ? null : String(d.location_id),
      name: String(d.description ?? "Ring camera"),
      kind: String(d.kind ?? ""),
      battery,
      onBattery: battery !== null && d.settings?.power_mode !== "wired",
      charging: Boolean(d.external_connection),
      lowBattery: d.alerts?.battery === "low",
      offline: d.alerts?.connection === "offline",
      // the Ring app's Modes or "Record Motion" off stops snapshots; Modes can turn live view off too
      motionOff: d.settings?.motion_detection_enabled === false,
      liveOff: d.settings?.live_view_disabled === true,
      hasLight: d.led_status !== undefined,
      lightOn: d.led_status === "on",
      hasSiren: d.siren_status !== undefined,
      sirenSeconds: Number(d.siren_status?.seconds_remaining) || 0,
      raw: d,
    };
  });
}

// One event from a camera's history, with what Ring saw: "ding" (doorbell), "live" (someone's live view),
// "person", "vehicle", "animal", "package" or "motion".
export function parseEvent(e) {
  const kind = String(e?.kind ?? "");
  const cv = e?.cv_properties ?? {};
  const types = [cv.detection_type, ...(Array.isArray(cv.detection_types) ? cv.detection_types : []).map((d) => d?.detection_type)]
    .filter(Boolean).map(String);
  const saw = kind === "ding" ? "ding"
    : kind.startsWith("on_demand") ? "live"
    : cv.person_detected === true || types.includes("human") ? "person"
    : types.includes("vehicle") ? "vehicle"
    : types.some((t) => /animal|pet/i.test(t)) ? "animal"
    : types.some((t) => /package/i.test(t)) ? "package"
    : "motion";
  return {
    id: String(e?.ding_id_str ?? e?.ding_id ?? ""), // a string: Ring's ids are too long for a JavaScript number
    at: Date.parse(e?.created_at),
    saw,
    ready: e?.recorded === true && e?.recording_status === "ready", // its video is saved and can be fetched
    raw: e,
  };
}

// A link into Ring's video storage, or null for anything else.
export function mediaUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && MEDIA_HOST.test(x.hostname) ? x.href : null;
  } catch {
    return null;
  }
}

// What Ring said when it refused something, kept short: its error fields if it answered JSON, else the start of
// what it sent. Ring's errors are plain words ("Device is busy"), never the token, which only goes the other way.
async function reasonOf(res) {
  const text = await res.text().catch(() => "");
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  const first = (x) => (Array.isArray(x) ? x[0] : x);
  const field = body && typeof body === "object"
    ? [body.error_description, body.error, body.message, body.reason, first(body.errors)?.message, first(body.errors)]
      .find((v) => typeof v === "string" && v.trim())
    : null;
  const why = String(field ?? text).replace(/\s+/g, " ").trim().slice(0, 200);
  return why ? `HTTP ${res.status}: ${why}` : `HTTP ${res.status}`;
}

// The host a link points at, to say where Ring sent something without repeating a pre-signed link.
function hostOf(u) {
  try {
    return new URL(u).hostname || null;
  } catch {
    return null;
  }
}

// --- the client ---------------------------------------------------------------------------------------------------

const cameraId = (camera) => String(camera?.id ?? camera);

export class RingClient {
  #store;
  #fetch;
  #deviceName;
  #pending = null;
  #deadToken = null; // the refresh token Ring last refused: not tried again until the store holds another
  #deadReason = null;
  #sessionAt = 0;
  #registering = null;

  // tokenStore: { read(), write(token) }, or tokenFile for a fileTokenStore (defaultTokenFile() if neither).
  // deviceName is how this client shows in the Ring app under Control Center → Authorized Client Devices.
  constructor({ tokenStore, tokenFile, deviceName = "ring-lite", fetch = globalThis.fetch } = {}) {
    this.#store = tokenStore ?? fileTokenStore(tokenFile);
    this.#deviceName = deviceName;
    this.#fetch = fetch;
  }

  // A token good for at least two more minutes, refreshed (and saved) when it isn't. One refresh at a time.
  async #access(force = false) {
    if (force && this.#pending) await this.#pending.catch(() => {});
    this.#pending ??= this.#refresh(force).finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #refresh(force) {
    let t = await this.#store.read();
    if (!t) throw new SignInError("Not signed in to Ring: run ring-lite-signin first", { signedOut: true });
    if (t.refreshToken === this.#deadToken) throw new SignInError(this.#deadReason);
    const fresh = (x) => !force && x.accessToken && x.accessExpiresAt - Date.now() > 120_000;
    if (fresh(t)) return t;
    const refresh = (x) => requestToken({ grant_type: "refresh_token", refresh_token: x.refreshToken }, { hardwareId: x.hardwareId, fetch: this.#fetch });
    let r = await refresh(t);
    if (r.status !== 200) {
      // another process sharing the store may have just swapped it
      const again = await this.#store.read();
      if (again && again.refreshToken !== t.refreshToken) {
        if (fresh(again)) return again;
        t = again;
        r = await refresh(t);
      }
    }
    if (r.status >= 400 && r.status < 500) {
      this.#deadToken = t.refreshToken;
      this.#deadReason = `Ring refused the saved sign-in (HTTP ${r.status}${r.body?.error ? `, ${r.body.error}` : ""}): sign in again`;
      throw new SignInError(this.#deadReason, { status: r.status });
    }
    if (r.status !== 200 || !r.body?.access_token) throw new RingError(`oauth.ring.com answered HTTP ${r.status}`, { status: r.status });
    const next = { ...tokenFrom(r.body, t), refreshedAt: new Date().toISOString() };
    await this.#store.write(next);
    return next;
  }

  #send(url, token, { method = "GET", json, accept = "application/json", timeoutMs = 20_000 } = {}) {
    return this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        hardware_id: token.hardwareId,
        "user-agent": USER_AGENT,
        accept,
        ...(json ? { "content-type": "application/json" } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  // Names this client in Ring's Control Center. Ring forgets clients that don't, so it's renewed every 12 hours.
  async #register(token) {
    const res = await this.#send(`${API_URL}clients_api/session`, token, {
      method: "POST",
      json: { device: { hardware_id: token.hardwareId, metadata: { api_version: 11, device_model: this.#deviceName }, os: "android" } },
    });
    if (!res.ok) throw new RingError(`Ring's session call answered HTTP ${res.status}`, { status: res.status });
    this.#sessionAt = Date.now();
  }

  // A request with the saved sign-in: a refused token is refreshed once, and a client Ring has forgotten is
  // registered again.
  async #api(url, options) {
    let token = await this.#access();
    if (Date.now() - this.#sessionAt > SESSION_MS) {
      this.#registering ??= this.#register(token).finally(() => {
        this.#registering = null;
      });
      await this.#registering;
    }
    let res = await this.#send(url, token, options);
    if (res.status === 401) {
      token = await this.#access(true);
      res = await this.#send(url, token, options);
    } else if (res.status === 404 && url.startsWith(`${API_URL}clients_api/`)) {
      const body = await res.clone().text().catch(() => "");
      if (body.includes(token.hardwareId)) {
        await this.#register(token);
        res = await this.#send(url, token, options);
      }
    }
    return res;
  }

  async #json(url, what, options) {
    const res = await this.#api(url, options);
    if (!res.ok) throw new RingError(`${what} answered ${await reasonOf(res)}`, { status: res.status });
    return res.json();
  }

  async #act(url, what, options) {
    const res = await this.#api(url, options);
    if (!res.ok) throw new RingError(`Ring didn't ${what} (${await reasonOf(res)})`, { status: res.status });
  }

  // The account's doorbells and cameras. Ring's cloud answers this without waking any camera.
  async cameras() {
    return parseCameras(await this.#json(`${API_URL}clients_api/ring_devices`, "Ring's camera list"));
  }

  // A fresh snapshot. A camera on battery wakes up for each one, so ask every 10 minutes or so, not every few
  // seconds. after: the takenMs of the last one, to get a newer one. Answers { jpeg, takenMs, takenAt }, takenAt on
  // this machine's clock.
  async snapshot(camera, { after } = {}) {
    const q = after ? `after-ms=${Number(after)}&` : "";
    const res = await this.#api(`${SNAPSHOT_URL}${enc(cameraId(camera))}?${q}extras=force`, { accept: "image/jpeg", timeoutMs: 30_000 });
    if (!res.ok) throw new RingError(`Ring's snapshot answered HTTP ${res.status}`, { status: res.status });
    const jpeg = Buffer.from(await res.arrayBuffer());
    if (!String(res.headers.get("content-type")).startsWith("image/") || jpeg.length < 200) throw new RingError("The camera sent no picture");
    const takenMs = Number(res.headers.get("x-time-millis")) || null;
    const serverNow = Date.parse(res.headers.get("date") ?? "");
    const takenAt = new Date(takenMs && serverNow ? Date.now() - Math.max(0, serverNow - takenMs) : Date.now());
    return { jpeg, takenMs, takenAt };
  }

  // A camera's latest events, newest first. camera must come from cameras() (this needs its locationId).
  async events(camera, { limit = 20 } = {}) {
    if (!camera?.locationId) throw new RingError("events() needs a camera from cameras()");
    const data = await this.#json(
      `${API_URL}clients_api/locations/${enc(camera.locationId)}/devices/${enc(cameraId(camera))}/events?limit=${Number(limit)}`,
      "Ring's event list"
    );
    return (data.events ?? []).map(parseEvent)
      .filter((e) => /^\d+$/.test(e.id) && Number.isFinite(e.at))
      .sort((a, b) => b.at - a.at);
  }

  // The pictures and clip lengths of a camera's saved events between from and to (ms): [{ id, thumbnailUrl,
  // seconds }]. thumbnailUrl is a pre-signed link for fetchMedia(), and runs out after a while.
  async eventMedia(camera, { from = Date.now() - 86_400_000, to = Date.now() + 60_000 } = {}) {
    const data = await this.#json(
      `${API_URL}clients_api/video_search/history?doorbot_id=${enc(cameraId(camera))}&date_from=${Number(from)}&date_to=${Number(to)}&order=desc&api_version=11&includes%5B%5D=pva`,
      "Ring's video search"
    );
    return (data.video_search ?? []).map((v) => ({
      id: String(v.ding_id_str ?? v.ding_id),
      thumbnailUrl: mediaUrl(v.thumbnail_url),
      seconds: Number(v.duration) || null,
      raw: v,
    }));
  }

  // An event's picture. Ring keeps it as one frame of H.264 video (type "image/h264"), not a JPEG: a browser can
  // decode it with WebCodecs' VideoDecoder.
  async eventThumbnail(camera, event, { maxBytes = THUMBNAIL_MAX } = {}) {
    const media = await this.eventMedia(camera, { from: event.at - 60_000, to: event.at + 60_000 });
    const url = media.find((m) => m.id === event.id)?.thumbnailUrl;
    if (!url) throw new RingError("Ring has no picture for that event yet", { status: 404 });
    return this.fetchMedia(url, { maxBytes });
  }

  // An event's video clip (an MP4), once the event is ready. event: an event or its id.
  async eventClip(event, { maxBytes = CLIP_MAX } = {}) {
    const res = await this.#api(`${API_URL}clients_api/dings/${enc(String(event?.id ?? event))}/share/play?disable_redirect=true`);
    if (!res.ok) throw new RingError(`Ring gave no video for that event (${await reasonOf(res)})`, { status: res.status });
    const body = await res.json().catch(() => ({}));
    const url = mediaUrl(body.url);
    if (!url) {
      const host = hostOf(body.url);
      throw new RingError(host
        ? `Ring's link to that video is on ${host}, which isn't Ring's video storage`
        : `Ring gave no link to that video (it answered ${Object.keys(body).join(", ") || "nothing"})`, { status: 404 });
    }
    return this.fetchMedia(url, { maxBytes });
  }

  // Bytes from Ring's video storage, with no token sent, and redirects followed only within that storage.
  // Answers { type, data }.
  async fetchMedia(url, { maxBytes = CLIP_MAX, timeoutMs = 60_000 } = {}) {
    let next = mediaUrl(url);
    if (!next) throw new RingError("That isn't a link to Ring's video storage");
    for (let hop = 0; hop < 3; hop++) {
      const res = await this.#fetch(next, { redirect: "manual", headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 300 && res.status < 400) {
        next = mediaUrl(new URL(res.headers.get("location") ?? "", next).href);
        if (!next) throw new RingError("Ring's video storage redirected somewhere else");
        continue;
      }
      if (!res.ok) throw new RingError(`Ring's video storage answered HTTP ${res.status}`, { status: res.status });
      if (Number(res.headers.get("content-length")) > maxBytes) throw new RingError("The file is larger than maxBytes");
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes) throw new RingError("The file is larger than maxBytes");
        chunks.push(chunk);
      }
      return { type: res.headers.get("content-type") || "application/octet-stream", data: Buffer.concat(chunks) };
    }
    throw new RingError("Ring's video storage redirected too often");
  }

  // --- controls: Ring's answer is taken as done; read cameras() a few seconds later to see what the camera did ---

  async setLight(camera, on) {
    if (camera?.hasLight === false) throw new RingError(`${camera.name} has no light`);
    await this.#act(`${API_URL}clients_api/doorbots/${enc(cameraId(camera))}/floodlight_light_${on ? "on" : "off"}`, `turn the light ${on ? "on" : "off"}`, { method: "PUT" });
  }

  // Ring sounds a siren for 30 seconds unless it's turned off sooner.
  async setSiren(camera, on) {
    if (camera?.hasSiren === false) throw new RingError(`${camera.name} has no siren`);
    await this.#act(`${API_URL}clients_api/doorbots/${enc(cameraId(camera))}/siren_${on ? "on" : "off"}`, `turn the siren ${on ? "on" : "off"}`, { method: "PUT" });
  }

  // Off stops recordings, alerts and snapshots. The Ring app's Modes can override it.
  async setMotionDetection(camera, enabled) {
    await this.#act(`${API_URL}devices/v1/devices/${enc(cameraId(camera))}/settings`, `turn motion detection ${enabled ? "on" : "off"}`, {
      method: "PATCH",
      json: { motion_settings: { motion_detection_enabled: Boolean(enabled) } },
    });
  }

  // --- live view ---------------------------------------------------------------------------------------------------

  // Starts live view from a WebRTC offer and answers { sessionId, sdp, maxMs }: give sdp to the peer connection as
  // its answer. Ring takes the offer whole, so wait for ICE gathering to finish before sending it. A camera on
  // battery streams to one place at a time; end the session when done, or Ring ends it after about 10 minutes.
  async startLiveView(camera, sdpOffer) {
    if (typeof sdpOffer !== "string" || !sdpOffer.startsWith("v=0")) throw new RingError("startLiveView needs a WebRTC SDP offer");
    if (camera?.liveOff) throw new RingError(`Live view is turned off for ${camera.name} in the Ring app (Modes)`, { status: 409 });
    const sessionId = randomUUID();
    const res = await this.#api(`${API_URL}integrations/v1/liveview/start`, {
      method: "POST",
      json: { session_id: sessionId, device_id: camera?.deviceId ?? Number(cameraId(camera)), sdp: sdpOffer, protocol: "webrtc" },
      timeoutMs: 30_000,
    });
    if (!res.ok) throw new RingError(`Ring didn't start live view (${await reasonOf(res)})`, { status: res.status });
    const answer = await res.json().catch(() => ({}));
    if (typeof answer.sdp !== "string") throw new RingError("Ring started live view but sent no SDP answer", { status: 502 });
    return { sessionId, sdp: answer.sdp, maxMs: LIVE_VIEW_MAX_MS };
  }

  // Turns the camera's speaker on, so audio the offer sends is heard. It's off until this is called, once a session.
  async enableLiveViewSpeaker(sessionId) {
    await this.#act(`${API_URL}integrations/v1/liveview/options`, "turn the camera's speaker on", {
      method: "PATCH",
      json: { session_id: String(sessionId), actions: ["turn_off_stealth_mode"] },
    });
  }

  async endLiveView(sessionId) {
    await this.#act(`${API_URL}integrations/v1/liveview/end`, "end live view", { method: "POST", json: { session_id: String(sessionId) } });
  }

  // --- events as they happen ---------------------------------------------------------------------------------------

  // Ring's apps get events by push through Google; this polls Ring's event lists instead (Ring's cloud, so it doesn't
  // wake cameras). The first round only learns what's there; each event after that is passed to onEvent(event,
  // camera) once, oldest first. Events that turn up more than maxAgeMs after they happened are skipped.
  // cameras: a list from cameras(), or leave it out to use every camera (re-read every 5 minutes).
  // Answers { stop() }.
  watchEvents({ onEvent, onError = () => {}, cameras, intervalMs = 20_000, maxAgeMs = 15 * 60_000 } = {}) {
    if (typeof onEvent !== "function") throw new TypeError("watchEvents needs onEvent");
    const seen = new Map(); // camera id → the event ids last listed
    let list = cameras ?? null;
    let listAt = 0;
    let stopped = false;
    let timer = null;
    const round = async () => {
      try {
        if (!cameras && Date.now() - listAt > CAMERAS_MS) {
          list = await this.cameras();
          listAt = Date.now();
        }
        for (const camera of list) {
          if (stopped) return;
          try {
            const events = await this.events(camera);
            const before = seen.get(camera.id);
            seen.set(camera.id, new Set(events.map((e) => e.id)));
            if (!before) continue;
            for (const e of events.filter((x) => !before.has(x.id) && Date.now() - x.at < maxAgeMs).reverse()) {
              if (!stopped) await onEvent(e, camera);
            }
          } catch (e) {
            if (e instanceof SignInError) throw e;
            onError(e, camera);
          }
        }
      } catch (e) {
        onError(e);
      } finally {
        if (!stopped) timer = setTimeout(round, intervalMs);
      }
    };
    round();
    return {
      stop() {
        stopped = true;
        clearTimeout(timer);
      },
    };
  }
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RingClient, RingError, SignInError, fileTokenStore, mediaUrl, parseCameras, parseEvent, signInWithPassword } from "../index.mjs";
import { API, OAUTH, SESSION_OK, fakeRing, freshToken, json, memoryStore } from "./fake-ring.mjs";

const DEVICES = `${API}clients_api/ring_devices`;
const devices = { doorbots: [], stickup_cams: [{ id: 123, description: "Front", location_id: "loc1", kind: "stickup_cam_v4", battery_life: 80, led_status: "off" }] };

test("parseEvent: what Ring saw", () => {
  const at = "2026-11-03T20:58:00Z";
  assert.equal(parseEvent({ kind: "motion", cv_properties: { person_detected: true }, created_at: at }).saw, "person");
  assert.equal(parseEvent({ kind: "motion", cv_properties: { detection_types: [{ detection_type: "vehicle" }] } }).saw, "vehicle");
  assert.equal(parseEvent({ kind: "motion", cv_properties: { detection_type: "other_animal" } }).saw, "animal");
  assert.equal(parseEvent({ kind: "ding" }).saw, "ding");
  assert.equal(parseEvent({ kind: "on_demand_link" }).saw, "live");
  assert.equal(parseEvent({ kind: "motion" }).saw, "motion");
  const e = parseEvent({ kind: "motion", ding_id: 7590000000000000001, ding_id_str: "7590000000000000001", created_at: at, recorded: true, recording_status: "ready" });
  assert.equal(e.id, "7590000000000000001"); // the string, not the rounded number
  assert.equal(e.at, Date.parse(at));
  assert.equal(e.ready, true);
});

test("parseCameras: merges kinds, takes the lower battery, knows wired", () => {
  const cams = parseCameras({
    doorbots: [{ id: 1, description: "Door", battery_life: "", settings: { power_mode: "wired" } }],
    stickup_cams: [{ id: 2, description: "Yard", battery_life: 90, battery_life_2: 40, siren_status: { seconds_remaining: 12 }, alerts: { connection: "offline" } }],
  });
  assert.deepEqual(cams.map((c) => [c.id, c.battery, c.onBattery, c.hasSiren, c.sirenSeconds, c.offline]), [
    ["1", null, false, false, 0, false],
    ["2", 40, true, true, 12, true],
  ]);
});

test("mediaUrl only takes Ring's video storage over HTTPS", () => {
  assert.ok(mediaUrl("https://x.devices.amazon.dev/clip.mp4?sig=1"));
  assert.equal(mediaUrl("http://x.devices.amazon.dev/clip.mp4"), null);
  assert.equal(mediaUrl("https://devices.amazon.dev.evil.example/clip.mp4"), null);
  assert.equal(mediaUrl("not a url"), null);
});

test("a fresh access token is used as is, and the client registers once", async () => {
  const ring = fakeRing([SESSION_OK, [DEVICES, devices]]);
  const client = new RingClient({ tokenStore: memoryStore(freshToken()), fetch: ring.fetch, deviceName: "Test board" });
  const [cam] = await client.cameras();
  await client.cameras();
  assert.equal(cam.name, "Front");
  assert.equal(ring.called(OAUTH).length, 0);
  const sessions = ring.called(`${API}clients_api/session`);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].body.device.metadata.device_model, "Test board");
  assert.equal(ring.called(DEVICES)[0].headers.authorization, "Bearer a1");
});

test("an expired access token is refreshed, and the swapped refresh token saved", async () => {
  const store = memoryStore(freshToken({ accessExpiresAt: Date.now() - 1 }));
  const ring = fakeRing([
    [`POST ${OAUTH}`, (c) => (c.body.refresh_token === "r1" ? { access_token: "a2", refresh_token: "r2", expires_in: 3600 } : json({}, 401))],
    SESSION_OK,
    [DEVICES, devices],
  ]);
  const client = new RingClient({ tokenStore: store, fetch: ring.fetch });
  await Promise.all([client.cameras(), client.cameras()]); // one refresh and one registration, not two
  assert.equal(ring.called(OAUTH).length, 1);
  assert.equal(ring.called(`${API}clients_api/session`).length, 1);
  assert.equal(store.token.refreshToken, "r2");
  assert.equal(store.token.accessToken, "a2");
  assert.equal(ring.called(DEVICES).at(-1).headers.authorization, "Bearer a2");
});

test("when another process already swapped the refresh token, its new one is used", async () => {
  const store = memoryStore(freshToken({ accessExpiresAt: 0 }));
  const ring = fakeRing([
    [`POST ${OAUTH}`, (c) => {
      if (c.body.refresh_token === "r1") {
        store.token = freshToken({ refreshToken: "r9", accessToken: "a9", accessExpiresAt: 0 }); // the other process
        return json({ error: "invalid_grant" }, 401);
      }
      return { access_token: "a10", refresh_token: "r10" };
    }],
    SESSION_OK,
    [DEVICES, devices],
  ]);
  await new RingClient({ tokenStore: store, fetch: ring.fetch }).cameras();
  assert.deepEqual(ring.called(OAUTH).map((c) => c.body.refresh_token), ["r1", "r9"]);
  assert.equal(store.token.refreshToken, "r10");
});

test("a refused sign-in is a SignInError, and isn't sent to Ring again", async () => {
  const ring = fakeRing([[`POST ${OAUTH}`, json({ error: "invalid_grant" }, 401)]]);
  const client = new RingClient({ tokenStore: memoryStore(freshToken({ accessExpiresAt: 0 })), fetch: ring.fetch });
  await assert.rejects(client.cameras(), (e) => e instanceof SignInError && /invalid_grant/.test(e.message));
  await assert.rejects(client.cameras(), SignInError);
  assert.equal(ring.called(OAUTH).length, 1);
});

test("no saved sign-in is a SignInError marked signedOut", async () => {
  const client = new RingClient({ tokenStore: memoryStore(null), fetch: fakeRing([]).fetch });
  await assert.rejects(client.cameras(), (e) => e instanceof SignInError && e.signedOut);
});

test("a 401 from the API refreshes once and retries", async () => {
  const ring = fakeRing([
    [`POST ${OAUTH}`, { access_token: "a2", refresh_token: "r2" }],
    SESSION_OK,
    [DEVICES, (c) => (c.headers.authorization === "Bearer a2" ? devices : json({}, 401))],
  ]);
  const [cam] = await new RingClient({ tokenStore: memoryStore(freshToken()), fetch: ring.fetch }).cameras();
  assert.equal(cam.id, "123");
  assert.equal(ring.called(OAUTH).length, 1);
});

test("a client Ring has forgotten is registered again", async () => {
  let forgotten = true;
  const ring = fakeRing([
    SESSION_OK,
    [DEVICES, () => (forgotten ? ((forgotten = false), json({ error: "hw-1 not found" }, 404)) : devices)],
  ]);
  await new RingClient({ tokenStore: memoryStore(freshToken()), fetch: ring.fetch }).cameras();
  assert.equal(ring.called(`${API}clients_api/session`).length, 2);
});

test("events: parsed, filtered and newest first", async () => {
  const ring = fakeRing([
    SESSION_OK,
    [`${API}clients_api/locations/loc1/devices/123/events`, { events: [
      { ding_id_str: "11", kind: "motion", created_at: "2026-11-03T10:00:00Z" },
      { ding_id_str: "12", kind: "ding", created_at: "2026-11-03T11:00:00Z" },
      { kind: "motion", created_at: "2026-11-03T12:00:00Z" }, // no id
    ] }],
  ]);
  const client = new RingClient({ tokenStore: memoryStore(freshToken()), fetch: ring.fetch });
  const events = await client.events(parseCameras(devices)[0]);
  assert.deepEqual(events.map((e) => [e.id, e.saw]), [["12", "ding"], ["11", "motion"]]);
  await assert.rejects(client.events({ id: "123" }), RingError);
});

test("fetchMedia sends no token, follows redirects only within Ring's storage, and caps the size", async () => {
  const ring = fakeRing([
    ["https://a.devices.amazon.dev/one", () => new Response(null, { status: 302, headers: { location: "https://b.devices.amazon.dev/two" } })],
    ["https://b.devices.amazon.dev/two", () => new Response("clip bytes", { headers: { "content-type": "video/mp4" } })],
    ["https://a.devices.amazon.dev/away", () => new Response(null, { status: 302, headers: { location: "https://example.com/" } })],
  ]);
  const client = new RingClient({ tokenStore: memoryStore(freshToken()), fetch: ring.fetch });
  const got = await client.fetchMedia("https://a.devices.amazon.dev/one");
  assert.equal(got.type, "video/mp4");
  assert.equal(got.data.toString(), "clip bytes");
  assert.ok(ring.calls.every((c) => !("authorization" in c.headers) && c.redirect === "manual"));
  await assert.rejects(client.fetchMedia("https://a.devices.amazon.dev/away"), /somewhere else/);
  await assert.rejects(client.fetchMedia("https://example.com/x"), RingError);
  await assert.rejects(client.fetchMedia("https://a.devices.amazon.dev/one", { maxBytes: 4 }), /larger/);
});

test("live view: the offer goes to Ring, its answer comes back", async () => {
  const ring = fakeRing([
    SESSION_OK,
    [`POST ${API}integrations/v1/liveview/start`, (c) => ({ sdp: `answer to ${c.body.sdp.slice(0, 3)} for ${c.body.device_id}` })],
    [`POST ${API}integrations/v1/liveview/end`, {}],
  ]);
  const client = new RingClient({ tokenStore: memoryStore(freshToken()), fetch: ring.fetch });
  const [cam] = parseCameras(devices);
  const live = await client.startLiveView(cam, "v=0\r\n...");
  assert.equal(live.sdp, "answer to v=0 for 123");
  assert.equal(ring.called(`${API}integrations/v1/liveview/start`)[0].body.protocol, "webrtc");
  await client.endLiveView(live.sessionId);
  assert.equal(ring.called(`${API}integrations/v1/liveview/end`)[0].body.session_id, live.sessionId);
  await assert.rejects(client.startLiveView(cam, "not sdp"), RingError);
  await assert.rejects(client.startLiveView({ ...cam, liveOff: true }, "v=0"), /turned off/);
});

test("controls go to the right endpoints, and refuse what a camera lacks", async () => {
  const ring = fakeRing([SESSION_OK, [`PUT ${API}`, {}], [`PATCH ${API}`, {}]]);
  const client = new RingClient({ tokenStore: memoryStore(freshToken()), fetch: ring.fetch });
  const [cam] = parseCameras(devices);
  await client.setLight(cam, true);
  await client.setMotionDetection(cam, false);
  await assert.rejects(client.setSiren(cam, true), /no siren/);
  assert.deepEqual(ring.calls.slice(1).map((c) => `${c.method} ${c.url.replace(API, "")}`), [
    "PUT clients_api/doorbots/123/floodlight_light_on",
    "PATCH devices/v1/devices/123/settings",
  ]);
  assert.equal(ring.calls.at(-1).body.motion_settings.motion_detection_enabled, false);
});

test("watchEvents: learns what's there first, then reports each new event once, oldest first", async () => {
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const old = { ding_id_str: "1", kind: "motion", created_at: at(60_000) };
  const newer = [
    { ding_id_str: "4", kind: "ding", created_at: at(0) },
    { ding_id_str: "3", kind: "motion", created_at: at(1000) },
    { ding_id_str: "2", kind: "motion", created_at: at(3_600_000) }, // turned up too late to tell
  ];
  let rounds = 0; // the third round onwards sees the newer events
  const ring = fakeRing([SESSION_OK, [`${API}clients_api/locations/`, () => ({ events: ++rounds >= 3 ? [...newer, old] : [old] })]]);
  const client = new RingClient({ tokenStore: memoryStore(freshToken()), fetch: ring.fetch });
  const seen = [];
  const errors = [];
  await new Promise((resolve) => {
    const watch = client.watchEvents({ cameras: parseCameras(devices), intervalMs: 5, onEvent: (e) => seen.push(e.id), onError: (e) => errors.push(e) });
    const check = setInterval(() => {
      if (rounds < 6) return;
      watch.stop();
      clearInterval(check);
      resolve();
    }, 5);
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(seen, ["3", "4"]);
});

test("signInWithPassword asks for the 2-step code, and retries a wrong one", async () => {
  const codes = [];
  const ring = fakeRing([[`POST ${OAUTH}`, (c) => {
    const code = c.headers["2fa-code"];
    if (!code) return json({ tsv_state: "sms", phone: "xxx-xxx-1234" }, 412);
    return code === "654321" ? { access_token: "a1", refresh_token: "r1", expires_in: 3600 } : json({ error: "Verification Code is invalid or expired" }, 400);
  }]]);
  const token = await signInWithPassword({
    email: "me@example.com",
    password: "pw",
    hardwareId: "hw-1",
    fetch: ring.fetch,
    askCode: ({ method, phone, attempt }) => (codes.push([method, phone, attempt]), attempt ? "654321" : "000000"),
  });
  assert.deepEqual(codes, [["sms", "xxx-xxx-1234", 0], ["sms", "xxx-xxx-1234", 1]]);
  assert.equal(token.refreshToken, "r1");
  assert.equal(token.hardwareId, "hw-1");
  assert.equal(ring.calls[0].body.grant_type, "password");
});

test("fileTokenStore round-trips, and reads a missing or broken file as signed out", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ring-lite-"));
  try {
    const store = fileTokenStore(path.join(dir, "sub", "ring-token.json"));
    assert.equal(await store.read(), null);
    await store.write(freshToken());
    assert.equal((await store.read()).refreshToken, "r1");
    assert.equal(JSON.parse(await readFile(store.file, "utf8")).hardwareId, "hw-1");
    await store.write({ broken: true });
    assert.equal(await store.read(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

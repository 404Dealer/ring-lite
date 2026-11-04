/** The saved sign-in. Ring swaps refreshToken at every refresh, so a store must really save each one. */
export interface RingToken {
  refreshToken: string;
  /** This client's own id at Ring; keep it across sign-ins so Ring sees the same device. */
  hardwareId: string;
  accessToken?: string;
  /** When accessToken runs out, in ms since 1970. */
  accessExpiresAt?: number;
  signedInAt?: string;
  refreshedAt?: string;
}

export interface TokenStore {
  /** The saved token, or null when there's none. Read before every refresh. */
  read(): Promise<RingToken | null>;
  write(token: RingToken): Promise<void>;
}

export interface FileTokenStore extends TokenStore {
  file: string;
}

export interface Camera {
  id: string;
  /** The id as Ring sent it (a number), for live view. */
  deviceId: number | string;
  locationId: string | null;
  name: string;
  kind: string;
  /** Percent, the lower of two batteries; null when wired. */
  battery: number | null;
  onBattery: boolean;
  charging: boolean;
  lowBattery: boolean;
  offline: boolean;
  /** Motion detection is off: no recordings, alerts or snapshots. */
  motionOff: boolean;
  /** Live view is turned off in the Ring app (Modes). */
  liveOff: boolean;
  hasLight: boolean;
  lightOn: boolean;
  hasSiren: boolean;
  sirenSeconds: number;
  /** Ring's own object, for anything not parsed. */
  raw: Record<string, unknown>;
}

export type Saw = "ding" | "live" | "person" | "vehicle" | "animal" | "package" | "motion";

export interface RingEvent {
  /** A string: Ring's ids are too long for a JavaScript number. */
  id: string;
  /** When it happened, in ms since 1970. */
  at: number;
  saw: Saw;
  /** Its video is saved and can be fetched. */
  ready: boolean;
  raw: Record<string, unknown>;
}

export interface EventMedia {
  id: string;
  /** A pre-signed link for fetchMedia(); it runs out after a while. */
  thumbnailUrl: string | null;
  seconds: number | null;
  raw: Record<string, unknown>;
}

export interface Media {
  type: string;
  data: Buffer;
}

export interface Snapshot {
  jpeg: Buffer;
  /** Ring's time for it; pass as `after` to get a newer one. */
  takenMs: number | null;
  /** When it was taken, on this machine's clock. */
  takenAt: Date;
}

export interface LiveView {
  sessionId: string;
  /** Ring's WebRTC answer, for the peer connection's setRemoteDescription. */
  sdp: string;
  maxMs: number;
}

export type CameraRef = Camera | string | number;

export interface RingClientOptions {
  tokenStore?: TokenStore;
  /** For a fileTokenStore; defaultTokenFile() if neither is given. */
  tokenFile?: string;
  /** How this client shows in the Ring app's Control Center. Default "ring-lite". */
  deviceName?: string;
  fetch?: typeof globalThis.fetch;
}

export interface WatchEventsOptions {
  onEvent(event: RingEvent, camera: Camera): void | Promise<void>;
  onError?(error: Error, camera?: Camera): void;
  /** Default: every camera, re-read every 5 minutes. */
  cameras?: Camera[];
  /** Default 20 000. */
  intervalMs?: number;
  /** Events that turn up later than this after they happened are skipped. Default 15 minutes. */
  maxAgeMs?: number;
}

export class RingClient {
  constructor(options?: RingClientOptions);
  cameras(): Promise<Camera[]>;
  /** Wakes a camera on battery: ask every 10 minutes or so, not every few seconds. */
  snapshot(camera: CameraRef, options?: { after?: number }): Promise<Snapshot>;
  /** Newest first. camera must come from cameras(). */
  events(camera: Camera, options?: { limit?: number }): Promise<RingEvent[]>;
  eventMedia(camera: CameraRef, options?: { from?: number; to?: number }): Promise<EventMedia[]>;
  /** One frame of H.264 ("image/h264"), not a JPEG: decode it with WebCodecs. */
  eventThumbnail(camera: CameraRef, event: RingEvent, options?: { maxBytes?: number }): Promise<Media>;
  /** An MP4, once the event is ready. */
  eventClip(event: RingEvent | string, options?: { maxBytes?: number }): Promise<Media>;
  /** Bytes from Ring's video storage, with no token sent. */
  fetchMedia(url: string, options?: { maxBytes?: number; timeoutMs?: number }): Promise<Media>;
  setLight(camera: CameraRef, on: boolean): Promise<void>;
  /** Ring sounds it for 30 seconds unless it's turned off sooner. */
  setSiren(camera: CameraRef, on: boolean): Promise<void>;
  setMotionDetection(camera: CameraRef, enabled: boolean): Promise<void>;
  /** Wait for ICE gathering to finish before sending the offer: Ring takes it whole. */
  startLiveView(camera: CameraRef, sdpOffer: string): Promise<LiveView>;
  enableLiveViewSpeaker(sessionId: string): Promise<void>;
  endLiveView(sessionId: string): Promise<void>;
  watchEvents(options: WatchEventsOptions): { stop(): void };
}

export class RingError extends Error {
  status?: number;
}

/** The saved sign-in is missing (signedOut) or Ring refused it: a person has to sign in again. */
export class SignInError extends RingError {
  signedOut: boolean;
}

export const LIVE_VIEW_MAX_MS: number;
export function defaultTokenFile(): string;
export function fileTokenStore(file?: string): FileTokenStore;
export function requestToken(
  grant: { grant_type: "password"; username: string; password: string } | { grant_type: "refresh_token"; refresh_token: string },
  options?: { hardwareId?: string; code?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }
): Promise<{ status: number; body: Record<string, any> }>;
export function signInWithPassword(options: {
  email: string;
  password: string;
  askCode?(challenge: { method: string | null; phone: string | null; attempt: number }): string | Promise<string>;
  hardwareId?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<RingToken>;
export function parseCameras(data: unknown): Camera[];
export function parseEvent(event: unknown): RingEvent;
export function mediaUrl(url: string): string | null;

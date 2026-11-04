# ring-lite

A small client for Ring cameras and doorbells, with **no dependencies** beyond Node's built-ins. It gets you
snapshots, event history with clips, the light, siren and motion switches, and **live view played by your own
browser** over WebRTC.

> **Unofficial.** Ring has no public API. ring-lite speaks the private one Ring's own apps use. It isn't affiliated
> with or endorsed by Ring or Amazon, and Ring can change that API at any time, which will break things until
> ring-lite is updated.

## Why another Ring library?

[ring-client-api](https://github.com/dgreif/ring) is the full-featured, well-maintained library, and everything
ring-lite knows about Ring's API was learned from it. Use it if you need Ring Alarm, Smart Lighting, chimes or
HomeKit.

ring-lite is for when you only want cameras and want the smallest footprint:

- **One file, no dependencies.** Nothing to audit but `index.mjs` itself.
- **Nothing in the background.** It doesn't sign up for Google push, subscribe your cameras to anything or open any
  ports. New events come from polling Ring's event list, which doesn't wake cameras.
- **Live view stays in the browser.** Your browser makes the WebRTC offer, ring-lite passes it to Ring with your
  token, and the video goes straight between Ring and the browser. Node never handles media, and the page never
  sees the token.
- **Few hosts.** It talks only to `oauth.ring.com`, `api.ring.com`, `app-snaps.ring.com` and Ring's video storage
  (`*.devices.amazon.dev`, through pre-signed links, with no token sent there).
- **Careful with the sign-in.** The token file is locked to your user. It's re-read before every refresh, so
  several processes can share one sign-in without spending a stale token. A refused sign-in isn't retried in a
  loop.

## Install

Node 20 or newer.

```bash
npm install github:404Dealer/ring-lite
```

## Sign in once

```bash
npx ring-lite-signin
```

It asks for your Ring email, password and the 2-step code. These go only to `oauth.ring.com`; the password is never
saved. What's saved is Ring's token:

- Windows: `%LOCALAPPDATA%\ring-lite\ring-token.json`
- macOS and Linux: `~/.config/ring-lite/ring-token.json`

The file is readable by your user only. Use `--file <path>` to keep it somewhere else, and `--device-name <name>`
to set how the client shows in the Ring app.

**That token is a full login to your Ring account.** Don't commit it or copy it anywhere you wouldn't put your
password. To cut a client off, open the Ring app → Control Center → Authorized Client Devices, remove it there,
then delete the file.

## Use

```js
import { RingClient } from "ring-lite";

const ring = new RingClient(); // the token from ring-lite-signin
const [front] = await ring.cameras();

const { jpeg, takenAt } = await ring.snapshot(front); // wakes a camera on battery
const events = await ring.events(front); // newest first: { id, at, saw, ready }
const clip = await ring.eventClip(events[0]); // { type: "video/mp4", data }

await ring.setLight(front, true);

ring.watchEvents({
  onEvent: (event, camera) => console.log(`${camera.name}: ${event.saw}`),
});
```

`event.saw` is one of `person`, `vehicle`, `animal`, `package`, `motion`, `ding` (the doorbell) or `live` (someone
opened live view).

### Live view

```js
// in the browser: audio both ways, video from the camera
const pc = new RTCPeerConnection();
pc.addTransceiver("audio", { direction: "sendrecv" });
pc.addTransceiver("video", { direction: "recvonly" });
await pc.setLocalDescription(await pc.createOffer());
// wait for ICE gathering to finish: Ring takes the offer whole
// ...send pc.localDescription.sdp to your server...

// on your server
const { sessionId, sdp } = await ring.startLiveView(camera, offerSdp);
// ...send sdp back; the browser calls pc.setRemoteDescription({ type: "answer", sdp })

await ring.enableLiveViewSpeaker(sessionId); // before talking through the camera
await ring.endLiveView(sessionId);
```

[`examples/live-view`](examples/live-view) is a complete one: a page with a button per camera and hold to talk.

### Examples

- [`examples/cameras.mjs`](examples/cameras.mjs) lists your cameras and their latest events. It's read-only.
- [`examples/watch-events.mjs`](examples/watch-events.mjs) prints events as they happen and can post each one to a
  webhook. Ring has no webhooks of its own, so this makes them.
- [`examples/live-view/server.mjs`](examples/live-view/server.mjs) runs live view in your browser on
  `http://127.0.0.1:8080`.

## API

| | |
|---|---|
| `new RingClient({ tokenFile?, tokenStore?, deviceName?, fetch? })` | `tokenStore` is any `{ read(), write(token) }` (a database, a secrets manager); its `write` must really save, because Ring swaps the refresh token every hour. |
| `cameras()` | Doorbells and cameras, with battery, online, light, siren and motion state. Doesn't wake them. |
| `snapshot(camera, { after? })` | `{ jpeg, takenMs, takenAt }`. Pass the last `takenMs` as `after` to get a newer one. |
| `events(camera, { limit? })` | The latest events, newest first (Ring answers up to 20). |
| `eventMedia(camera, { from?, to? })` | The pictures and clip lengths of saved events. |
| `eventThumbnail(camera, event)` | The event's picture: one H.264 frame (`image/h264`), not a JPEG. A browser decodes it with WebCodecs. |
| `eventClip(event)` | The event's MP4 clip, once `event.ready`. |
| `setLight(camera, on)`, `setSiren(camera, on)`, `setMotionDetection(camera, on)` | Ring sounds the siren for 30 s unless it's turned off sooner. Motion off stops recordings, alerts and snapshots. |
| `startLiveView(camera, sdpOffer)`, `enableLiveViewSpeaker(sessionId)`, `endLiveView(sessionId)` | WebRTC live view. |
| `watchEvents({ onEvent, onError?, cameras?, intervalMs?, maxAgeMs? })` | Polls every 20 s. Each new event goes to `onEvent` once. Answers `{ stop() }`. |
| `signInWithPassword({ email, password, askCode })` | For building your own sign-in. |

Errors are `RingError`, carrying Ring's HTTP `status` where there was one. A `SignInError` means a person has to
sign in again: `signedOut` is true when there's no saved sign-in at all.

## Limits

- **Battery cameras wake for each snapshot and live view.** Ask for a snapshot every 10 minutes or so, not every few
  seconds. A battery camera streams to one place at a time and can't take a snapshot while streaming.
- **Ring ends live view after about 10 minutes.**
- **Events arrive up to one poll late** (20 s by default), not instantly as in Ring's app.
- **Clips and event pictures need a Ring Protect plan** with recordings on.
- **The Ring app's Modes can turn off** motion, snapshots or live view for a camera, and override `setMotionDetection`.
- **Not supported:** Ring Alarm, Smart Lighting, chimes, intercoms.

## Tests

```bash
npm test
```

The tests run against a stand-in for Ring's servers, so they need no account. They can't tell you Ring hasn't
changed something; `examples/cameras.mjs` against your own account does.

## License

MIT. Thanks to [ring-client-api](https://github.com/dgreif/ring) and its contributors, whose work mapped the API this
uses.

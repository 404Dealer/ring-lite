// Prints each new event as it happens (within about 20 seconds), and posts it to a webhook if you give one: Ring
// has no webhooks of its own, so this makes them.
//   node examples/watch-events.mjs [webhook URL]
import { RingClient } from "ring-lite";

const webhook = process.argv[2];
const ring = new RingClient();

ring.watchEvents({
  async onEvent(event, camera) {
    console.log(`${new Date(event.at).toLocaleTimeString()}  ${camera.name}: ${event.saw}`);
    if (webhook) {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ camera: camera.name, cameraId: camera.id, event: event.saw, eventId: event.id, at: new Date(event.at).toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`  the webhook answered HTTP ${res.status}`);
    }
  },
  onError(error, camera) {
    console.error(`${camera ? `${camera.name}: ` : ""}${error.message}`);
  },
});
console.log("Watching for events. Ctrl+C to stop.");

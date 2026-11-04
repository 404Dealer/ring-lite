// Lists your cameras and each one's latest events. Read-only: it wakes no camera and changes nothing.
//   node examples/cameras.mjs
import { RingClient } from "ring-lite";

const ring = new RingClient();
for (const camera of await ring.cameras()) {
  const power = camera.battery === null ? "wired" : `battery ${camera.battery}%${camera.charging ? ", charging" : ""}`;
  console.log(`${camera.name} (${camera.kind}, ${power}${camera.offline ? ", offline" : ""})`);
  for (const event of (await ring.events(camera, { limit: 5 }))) {
    console.log(`  ${new Date(event.at).toLocaleString()}  ${event.saw}${event.ready ? "" : " (video not saved yet)"}`);
  }
}

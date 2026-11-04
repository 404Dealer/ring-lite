// Live view in your browser: this serves a page on http://127.0.0.1:8080 that makes the WebRTC offer, and passes
// it to Ring with the token. The video goes straight between Ring and the browser; the token never reaches the page.
//   node examples/live-view/server.mjs
import { readFile } from "node:fs/promises";
import http from "node:http";
import { RingClient } from "ring-lite";

const PORT = Number(process.env.PORT) || 8080;
const ring = new RingClient();
let cameras = await ring.cameras();
const page = await readFile(new URL("./page.html", import.meta.url));

async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error("too large");
  }
  return JSON.parse(raw || "{}");
}

const actions = {
  async start({ cameraId, sdp }) {
    cameras = await ring.cameras();
    const camera = cameras.find((c) => c.id === String(cameraId));
    if (!camera) throw new Error("unknown camera");
    return ring.startLiveView(camera, sdp);
  },
  async talk({ sessionId }) {
    await ring.enableLiveViewSpeaker(sessionId);
    return {};
  },
  async end({ sessionId }) {
    await ring.endLiveView(sessionId);
    return {};
  },
};

http.createServer(async (req, res) => {
  // Only this machine: a web page elsewhere that points its own name at 127.0.0.1 still sends that name here.
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return res.writeHead(403).end();
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  }
  if (req.method === "GET" && url.pathname === "/cameras") {
    return res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(cameras.map(({ id, name, liveOff }) => ({ id, name, liveOff }))));
  }
  const action = req.method === "POST" && actions[url.pathname.slice(1)];
  // Other sites' pages can't send this header without a preflight this server never answers.
  if (!action || req.headers["x-ring-lite"] !== "1") return res.writeHead(404).end();
  try {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await action(await body(req))));
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" }).end(e.message);
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Open http://127.0.0.1:${PORT}/`));

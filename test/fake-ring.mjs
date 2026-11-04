// A stand-in for Ring's servers: a fetch that answers from a list of routes and records every call.
export function fakeRing(routes) {
  const calls = [];
  async function fetch(url, init = {}) {
    const method = init.method ?? "GET";
    const call = { url: String(url), method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect };
    calls.push(call);
    for (const [pattern, answer] of routes) {
      const [m, u] = pattern.includes(" ") ? pattern.split(" ") : ["GET", pattern];
      if (m === method && call.url.startsWith(u)) {
        const r = typeof answer === "function" ? await answer(call) : answer;
        return r instanceof Response ? r : json(r);
      }
    }
    return new Response(`no route for ${method} ${call.url}`, { status: 599 });
  }
  return { fetch, calls, called: (prefix) => calls.filter((c) => c.url.startsWith(prefix)) };
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function memoryStore(token) {
  const store = {
    token,
    writes: 0,
    async read() {
      return store.token ? structuredClone(store.token) : null;
    },
    async write(t) {
      store.writes++;
      store.token = structuredClone(t);
    },
  };
  return store;
}

export const OAUTH = "https://oauth.ring.com/oauth/token";
export const API = "https://api.ring.com/";

// A token whose access part is still good for an hour.
export const freshToken = (extra = {}) => ({
  refreshToken: "r1", hardwareId: "hw-1", accessToken: "a1", accessExpiresAt: Date.now() + 3_600_000, ...extra,
});

export const SESSION_OK = ["POST https://api.ring.com/clients_api/session", {}];

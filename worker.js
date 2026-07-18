// Cloudflare Worker — a tiny WebRTC signalling mailbox for true-remote casting
// (when the browser can't reach the phone's LAN address). It carries only the
// SDP offer/answer blobs (a few KB of text) — never any video. Media still flows
// peer-to-peer over WebRTC.
//
// Deploy:
//   1. Create a KV namespace and bind it as SIGNAL:
//        wrangler kv:namespace create SIGNAL
//      then add the binding to wrangler.toml:
//        [[kv_namespaces]]
//        binding = "SIGNAL"
//        id = "<the id printed above>"
//   2. wrangler deploy
//   3. Point the app's "Remote signalling URL" setting at the deployed origin,
//      e.g. https://plex-signal.<you>.workers.dev
//
// Routes (room is the short share code):
//   PUT  /rtc/offer/<room>    phone publishes its offer
//   GET  /rtc/offer/<room>    browser fetches the offer
//   POST /rtc/answer/<room>   browser posts its answer
//   GET  /rtc/answer/<room>   phone polls for the answer (deleted once read)
// Blobs expire after 5 minutes so stale sessions can't pile up.

const TTL = 300;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/rtc\/(offer|answer)\/([A-Za-z0-9_-]{1,64})$/);
    if (!m) return new Response("not found", { status: 404, headers: CORS });
    const [, kind, room] = m;
    const key = `${kind}:${room}`;

    if (request.method === "PUT" || request.method === "POST") {
      const body = await request.text();
      if (body.length > 100_000) return new Response("too large", { status: 413, headers: CORS });
      await env.SIGNAL.put(key, body, { expirationTtl: TTL });
      return new Response("ok", { headers: CORS });
    }

    if (request.method === "GET") {
      const val = await env.SIGNAL.get(key);
      if (val == null) return new Response("", { status: 404, headers: CORS });
      // The phone consumes the answer once; the offer stays for the TTL so a
      // viewer that reloads can re-fetch it.
      if (kind === "answer") await env.SIGNAL.delete(key);
      return new Response(val, { headers: { ...CORS, "Content-Type": "text/plain" } });
    }

    return new Response("method not allowed", { status: 405, headers: CORS });
  },
};

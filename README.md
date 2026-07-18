# Remote WebRTC casting

Stream a downloaded file straight from the phone to any browser, peer-to-peer,
with **no public IP and no media relay**. WebRTC/ICE punches through NAT; the
browser plays via MSE/hls.js, pulling the cast package's HLS segments over the
data channel. Only tiny SDP text passes through a signalling mailbox — never
video.

## Pieces

| Piece | Where it runs | What it does |
|-------|---------------|--------------|
| `index.html` | the phone (LAN) **or** GitHub Pages (remote) | the browser receiver (WebRTC answerer + MSE player) |
| `worker.js` | Cloudflare Workers (remote only) | the offer/answer mailbox, keyed by a short share code |
| phone app | iOS | creates the offer, serves the segments over the data channel |

## LAN (zero setup — this is what the app does out of the box)

The phone hosts both the page and the mailbox. Pick **Remote (P2P)** in the cast
menu; the app shows a `http://<phone-ip>:<port>/rtc?room=<code>` URL + QR. Open it
on any device **on the same network**. Proves the P2P media path with no
external infrastructure. (Same network, so it overlaps with plain web-cast — this
mode is mainly the test/proof path.)

## True remote (different networks)

The browser can't reach the phone, so the **page** lives on GitHub Pages and the
**handshake** goes through the Cloudflare mailbox:

1. **GitHub Pages** — this `docs/` folder is already Pages-ready. In the repo
   settings enable Pages from `main` / `docs`. The receiver is then at
   `https://<you>.github.io/<repo>/rtc/`.
2. **Cloudflare Worker** — deploy `worker.js` (see the header comment for the KV
   binding + `wrangler deploy`). Note the origin, e.g.
   `https://plex-signal.<you>.workers.dev`.
3. **App settings** — set *Remote page URL* to the Pages URL and *Remote
   signalling URL* to the Worker origin. The phone then `PUT`s its offer to the
   Worker, shows `…/rtc/?sig=<worker>&room=<code>`, and polls for the answer.

### STUN only, no TURN (for now)

ICE uses Google's public STUN. That connects on most home networks but **fails
when both ends are behind symmetric NAT** (common on cellular/CGNAT). Adding a
TURN server later is just one more entry in the `iceServers` list on both ends —
no other changes. Until then, remote casting is "works on most Wi-Fi, may fail on
mobile data".

### The real ceiling

P2P removes the relay, but the **phone's upload bandwidth** still caps the
stream — it's uploading the whole thing to the viewer. Cast packages (often
transcoded/lower-bitrate HLS) help here.

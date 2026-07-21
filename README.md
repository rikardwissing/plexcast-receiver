# Plex Cast receiver and signaling

This repository owns both public pieces of remote browser casting:

- `index.html` is the receiver deployed at `https://tv.rikard.dev`.
- `signal/` is the Cloudflare Worker deployed at
  `https://plexcast-signal.rikard-wissing.workers.dev`.

Only signaling data crosses Cloudflare. Video still travels peer-to-peer over
the WebRTC data channel.

## Durable Object signaling

Each normalized room is one SQLite-backed `SignalRoom` Durable Object. Sender
and viewer use hibernating WebSockets, so an idle paired TV remains reachable
without browser polling or periodic KV writes. The room stores only the current
offer, answer, generation, selected viewer, and five-minute expiry.

The v1 socket endpoint is:

```text
GET /rtc/ws/<room>?role=sender|viewer&session=<stable-session-id>
```

Presence and service health are available at:

```text
GET /rtc/presence/<pairing-token>
GET /health
```

The old HTTP offer/answer routes remain backed by the same Durable Object, so
old and new app/page combinations can connect during rollout:

```text
PUT  /rtc/offer/<room>
GET  /rtc/offer/<room>
POST /rtc/answer/<room>
GET  /rtc/answer/<room>
```

The root `worker.js` and `wrangler.toml` are the previous KV implementation and
are retained only as rollback artifacts. New work and deployments use
`signal/wrangler.jsonc`.

## Develop and verify

```bash
cd signal
npm install
npm run check
npm test
npm run test:browser
npm run test:mse
npx wrangler deploy --dry-run --env staging
```

`npm test` runs the Durable Object protocol/compatibility suite in the Workers
runtime. `npm run test:browser` starts the Worker locally and verifies the real
receiver page in headless Chrome, including pushed offers, answers, presence,
the absence of the old polling loop, and the outage message.
`npm run test:mse` uses FFmpeg to generate a temporary two-audio-track MP4,
streams it through the real MP4Box/MediaSource engine in Chrome, and verifies
repeated and rapid audio changes without replacing or emptying the video source.
It also verifies that an idle data-channel request times out and aborts cleanly,
and that the MSE byte pump retries a transient range failure at the same offset.

## Deploy

Wrangler defines isolated `staging` and `production` environments. Deploy the
Worker before the page so the new receiver's socket endpoint already exists:

```bash
cd signal
npm run deploy:staging
# verify staging
npm run deploy:production
```

After the production health/protocol checks pass, push this repository's page
changes and wait for GitHub Pages at `tv.rikard.dev`. The Durable Object design
assumes a Workers Paid account and removes the former KV daily-write quota from
the signaling hot path.

## Media-network limitation

ICE currently uses public STUN servers without TURN. Signaling can be healthy
while peer connectivity still fails when both ends are behind restrictive or
symmetric NAT. Adding TURN later does not require another signaling redesign.

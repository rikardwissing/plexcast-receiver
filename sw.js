// Service Worker: lets the <video> element stream a plain progressive MP4 over
// the WebRTC data channel with native HTTP Range semantics — a rolling window of
// small chunks, seekable, never the whole file.
//
// The data channel lives in the PAGE (index.html), not here, so this worker
// bridges to it: it intercepts the video's range fetches, asks the page for the
// requested byte window over the channel, and streams the reply back. The body
// is a pull-driven stream, so when the <video> buffer fills and stops reading,
// we stop asking the page — and the phone stops reading the file.
//
// Seeking aborts the fetch → the stream is cancelled → we tell the page to abort
// the in-flight window at the SENDER too (its serve loop drops a cancelled id).
// Without that, a stale window keeps draining and — because the sender's IO
// queue is serial — blocks the newly-seeked range, so rapid scrubbing over a
// slow (cellular) uplink would stall and never recover.
//
// The page points the element at:  __rtc_stream__?p=<data-channel path>
// e.g.  __rtc_stream__?p=%2Fmedia  → the phone's "/media".

const MARKER = "/__rtc_stream__";
const WINDOW = 256 * 1024; // per data-channel round-trip — small so a seek's
                           // stale window drains fast and the queue frees quickly.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.endsWith(MARKER)) return;      // not ours — let it pass
  const path = url.searchParams.get("p");
  if (!path) return;
  event.respondWith(serve(event.request, path));
});

async function serve(request, path) {
  const rangeHeader = request.headers.get("range");
  let start = 0, end = null, hasRange = false;
  const m = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (m) {
    hasRange = true;
    if (m[1]) start = parseInt(m[1], 10);
    if (m[2]) end = parseInt(m[2], 10);
  }

  let cancelled = false;
  let inflight = null;   // the current window's { abort } while awaiting the page

  // First window — also tells us the total size (for Content-Range/Length).
  const firstEnd = end == null ? start + WINDOW - 1 : Math.min(start + WINDOW - 1, end);
  const first = await ask(path, start, firstEnd, (a) => { inflight = a; });
  if (!first || (first.status && first.status >= 400) || !first.bytes) {
    return new Response("upstream error", { status: 502 });
  }
  const total = first.total || 0;
  const lastByte = end == null ? (total > 0 ? total - 1 : Number.MAX_SAFE_INTEGER)
                               : Math.min(end, total > 0 ? total - 1 : end);
  const contentLength = total > 0 ? Math.max(0, lastByte - start + 1) : undefined;

  let cursor = start + first.bytes.byteLength;
  let head = first.bytes;

  const stream = new ReadableStream({
    start(controller) {
      if (head && head.byteLength) controller.enqueue(new Uint8Array(head));
      head = null;
      if (cursor > lastByte) controller.close();
    },
    async pull(controller) {
      if (cancelled || cursor > lastByte) { controller.close(); return; }
      const upto = Math.min(cursor + WINDOW - 1, lastByte);
      const win = await ask(path, cursor, upto, (a) => { inflight = a; });
      if (cancelled) return;   // seeked away while awaiting — drop it
      if (!win || !win.bytes || win.bytes.byteLength === 0) { controller.close(); return; }
      controller.enqueue(new Uint8Array(win.bytes));
      cursor += win.bytes.byteLength;
      if (cursor > lastByte) controller.close();
    },
    cancel() {                 // the <video> seeked/stopped
      cancelled = true;
      if (inflight) inflight.abort();   // stop the sender streaming the stale window
    }
  });

  const headers = {
    "Content-Type": first.ctype || "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (contentLength != null) headers["Content-Length"] = String(contentLength);
  if (hasRange && total > 0) headers["Content-Range"] = `bytes ${start}-${lastByte}/${total}`;
  return new Response(stream, { status: hasRange ? 206 : 200, headers });
}

/// Ask the receiver page (which owns the data channel) for one byte window.
/// `setAbort` receives an { abort } handle that tells the page to abort THIS
/// window's request at the sender (and unblocks our await).
async function ask(path, start, end, setAbort) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = clients[0];
  if (!client) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    channel.port1.onmessage = (ev) => { if (!settled) { settled = true; resolve(ev.data); } };
    setAbort({
      abort() {
        if (settled) return;
        settled = true;
        try { channel.port1.postMessage({ abort: true }); } catch (e) {}
        resolve(null);
      }
    });
    client.postMessage({ type: "rtc-range", path, start, end }, [channel.port2]);
  });
}

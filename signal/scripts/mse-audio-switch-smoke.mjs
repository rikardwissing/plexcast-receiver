import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const signalRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const receiverRoot = path.dirname(signalRoot);
const origin = "http://127.0.0.1:8802";

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function waitFor(check, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch { /* playback is still moving to the requested state */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `${command} exited ${code}`)));
  });
}

async function makeFixture(target) {
  await run(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
    "-t", "18",
    "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "96k",
    "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=swe",
    "-movflags", "+faststart", target,
  ]);
}

function startServer(fixture) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".mp4": "video/mp4" };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", origin).pathname;
    let target;
    if (pathname === "/fixture.mp4") target = fixture;
    else {
      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      target = path.resolve(receiverRoot, relative);
      if (!target.startsWith(receiverRoot + path.sep)) {
        response.writeHead(403).end();
        return;
      }
    }
    try {
      const body = await readFile(target);
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)?$/);
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
        if (start >= body.length || end < start) {
          response.writeHead(416, { "Content-Range": `bytes */${body.length}` }).end();
          return;
        }
        const part = body.subarray(start, end + 1);
        response.writeHead(206, {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${body.length}`,
          "Content-Length": part.length,
          "Content-Type": types[path.extname(target)] ?? "application/octet-stream",
        });
        response.end(part);
        return;
      }
      response.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Content-Length": body.length,
        "Content-Type": types[path.extname(target)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8802, "127.0.0.1", () => resolve(server));
  });
}

const tempRoot = await mkdtemp(path.join(tmpdir(), "plexcast-mse-switch-"));
const fixture = path.join(tempRoot, "multi-audio.mp4");
let server;
let browser;
try {
  await makeFixture(fixture);
  assert((await stat(fixture)).size > 0, "ffmpeg did not create the MP4 fixture");
  server = await startServer(fixture);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  await page.goto(`${origin}/?qa=1&requestIdleMs=80&sig=${encodeURIComponent("http://127.0.0.1:1")}`);
  await page.waitForFunction(() => Boolean(window.PLEXCAST_QA?.MseEngine));

  // A data channel that remains nominally open but returns no bytes must reject
  // the request and send an abort instead of leaving it pending forever.
  const timeoutResult = await page.evaluate(async () => {
    const sent = [];
    const channel = { readyState: "open", send: (message) => { sent.push(JSON.parse(message)); } };
    window.PLEXCAST_QA.setDataChannel(channel);
    let error = "";
    try { await window.PLEXCAST_QA.fetchOverChannel("/never-answers", {}); }
    catch (caught) { error = String(caught); }
    window.PLEXCAST_QA.setDataChannel(null);
    return {
      error,
      pending: window.PLEXCAST_QA.pendingCount(),
      sent,
      trace: window.PLEXCAST_TRACE.slice(),
    };
  });
  assert(timeoutResult.error.includes("made no progress"),
    `idle request did not time out: ${JSON.stringify(timeoutResult)}`);
  assert(timeoutResult.pending === 0, "timed-out request remained pending");
  assert(timeoutResult.sent.some((message) => message.t === "abort"),
    "timed-out request did not abort the sender operation");

  await page.evaluate(() => {
    const video = window.PLEXCAST_QA.video;
    video.muted = true;
    window.PLEXCAST_QA.injectedFetchFailure = false;
    const fetchRange = async (url, options) => {
      // The MSE byte pump must retry at the same offset after a transient
      // transport failure; before this regression fix one rejection ended the
      // pump permanently and playback stalled once the existing buffer drained.
      if (!window.PLEXCAST_QA.injectedFetchFailure) {
        window.PLEXCAST_QA.injectedFetchFailure = true;
        throw new Error("injected transport timeout");
      }
      const response = await fetch(url, {
        headers: { Range: `bytes=${options.start}-${options.end}` },
      });
      if (response.status === 416) return { data: new Uint8Array() };
      if (!response.ok) throw new Error(`range request failed: ${response.status}`);
      return { data: new Uint8Array(await response.arrayBuffer()) };
    };
    const engine = new window.PLEXCAST_QA.MseEngine("/fixture.mp4", 0, fetchRange);
    window.PLEXCAST_QA.engine = engine;
    video.src = engine.objectUrl;
    video.play().catch(() => {});
  });
  await waitFor(() => page.evaluate(() =>
    window.PLEXCAST_QA.engine.audioTracks.length === 2 && window.PLEXCAST_QA.video.currentTime > 1),
  "multi-audio MSE fixture never began playback");

  await page.evaluate(() => {
    const video = window.PLEXCAST_QA.video;
    window.PLEXCAST_QA.mediaUrl = video.src;
    window.PLEXCAST_QA.emptied = 0;
    video.addEventListener("emptied", () => { window.PLEXCAST_QA.emptied += 1; });
  });

  async function switchTo(index) {
    const before = await page.evaluate(() => window.PLEXCAST_QA.video.currentTime);
    await page.evaluate((next) => window.PLEXCAST_QA.engine.setAudioTrack(next), index);
    await waitFor(() => page.evaluate((next) => {
      const qa = window.PLEXCAST_QA;
      return qa.engine.wantAudioIndex === next && !qa.engine.audioSwitching &&
        qa.engine.audioCovers(qa.video.currentTime);
    }, index), `native switch to audio track ${index} did not complete`);
    await waitFor(() => page.evaluate((time) => window.PLEXCAST_QA.video.currentTime > time + 0.75, before),
      `playback did not advance after switching to audio track ${index}`);
  }

  await switchTo(1);
  await switchTo(0);
  await page.evaluate(() => {
    const engine = window.PLEXCAST_QA.engine;
    engine.setAudioTrack(1);
    setTimeout(() => engine.setAudioTrack(0), 15);
    setTimeout(() => engine.setAudioTrack(1), 30);
  });
  await waitFor(() => page.evaluate(() => {
    const qa = window.PLEXCAST_QA;
    return qa.engine.wantAudioIndex === 1 && !qa.engine.audioSwitching &&
      qa.engine.pendingAudioIndex == null && qa.engine.audioCovers(qa.video.currentTime);
  }), "rapid latest-wins audio switching did not settle on track 1");
  const result = await page.evaluate(() => ({
    sameMediaUrl: window.PLEXCAST_QA.video.src === window.PLEXCAST_QA.mediaUrl,
    emptied: window.PLEXCAST_QA.emptied,
    trace: window.PLEXCAST_TRACE.slice(),
  }));
  assert(result.sameMediaUrl, "audio switching replaced the video MediaSource URL");
  assert(result.emptied === 0, "audio switching emptied/reloaded the video element");
  assert(result.trace.filter((line) => line.includes("(native,")).length >= 3,
    `not every audio change completed through the native path: ${result.trace.join(" | ")}`);
  assert(result.trace.some((line) => line.includes("injected transport timeout") && line.includes("retrying")),
    `MSE pump did not retry the injected transport failure: ${result.trace.join(" | ")}`);
  assert(!result.trace.some((line) => line.includes("native audio fallback")),
    "native switching fell back to a full media reload");
  console.log("direct-MP4 native audio switching smoke test passed");
} finally {
  await browser?.close();
  if (server) {
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(tempRoot, { recursive: true, force: true });
}

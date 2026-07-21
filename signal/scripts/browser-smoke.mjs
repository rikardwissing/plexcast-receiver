import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const signalRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const receiverRoot = path.dirname(signalRoot);
const workerOrigin = "http://127.0.0.1:8799";
const receiverOrigin = "http://127.0.0.1:8800";

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function waitFor(check, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch { /* service is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function startStaticServer() {
  const types = { ".html": "text/html", ".js": "text/javascript" };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", receiverOrigin).pathname;
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const target = path.resolve(receiverRoot, relative);
    if (!target.startsWith(receiverRoot + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(target);
      response.writeHead(200, { "Content-Type": types[path.extname(target)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8800, "127.0.0.1", () => resolve(server));
  });
}

function openSocket(url) {
  const socket = new WebSocket(url);
  const queue = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("sender socket failed")), { once: true });
  });
  return {
    socket,
    opened,
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve)),
  };
}

let worker;
let staticServer;
let browser;
let workerLog = "";
try {
  staticServer = await startStaticServer();
  worker = spawn(path.join(signalRoot, "node_modules", ".bin", "wrangler"),
    ["dev", "--ip", "127.0.0.1", "--port", "8799"],
    { cwd: signalRoot, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (chunk) => { workerLog += String(chunk); });
  worker.stderr.on("data", (chunk) => { workerLog += String(chunk); });
  await waitFor(async () => (await fetch(workerOrigin + "/health")).ok,
                "local signaling worker did not start", 20_000);

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  await context.route("https://cdn.jsdelivr.net/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await context.addInitScript(() => {
    class FakePeerConnection {
      constructor() {
        this.iceGatheringState = "complete";
        this.connectionState = "new";
        this.iceConnectionState = "new";
        this.localDescription = null;
      }
      setRemoteDescription(description) { this.remoteDescription = description; return Promise.resolve(); }
      createAnswer() { return Promise.resolve({ type: "answer", sdp: "browser-answer" }); }
      setLocalDescription(description) { this.localDescription = description; return Promise.resolve(); }
      close() {}
    }
    globalThis.RTCPeerConnection = FakePeerConnection;
  });

  const page = await context.newPage();
  await page.goto(`${receiverOrigin}/?sig=${encodeURIComponent(workerOrigin)}`);
  await page.evaluate(() => localStorage.setItem("plexcast.pairs", JSON.stringify([
    { id: "browser-room", name: "Browser smoke sender" },
  ])));
  await page.reload();
  await page.locator(".pairrow").waitFor();
  await waitFor(async () => (await (await fetch(workerOrigin + "/rtc/presence/browser-room")).json()).online,
                "receiver socket never became present");

  const sender = openSocket("ws://127.0.0.1:8799/rtc/ws/browser-room?role=sender&session=browser-smoke");
  await sender.opened;
  assert((await sender.next()).type === "ready", "sender did not receive ready");
  const presence = await sender.next();
  assert(presence.type === "viewerPresence" && presence.online, "sender did not see the receiver");

  const encodedOffer = Buffer.from(JSON.stringify({ type: "offer", sdp: "browser-offer" })).toString("base64");
  sender.socket.send(JSON.stringify({ type: "offer", generation: "browser-generation", sdp: encodedOffer }));
  assert((await sender.next()).type === "ack", "worker did not acknowledge the browser offer");
  const answer = await sender.next();
  assert(answer.type === "answer" && answer.generation === "browser-generation",
         "receiver did not answer the pushed offer");
  const decodedAnswer = JSON.parse(Buffer.from(answer.sdp, "base64").toString("utf8"));
  assert(decodedAnswer.sdp === "browser-answer", "receiver answer payload was malformed");
  assert(await page.evaluate(() => window.PLEXCAST_TRACE.some((line) => line.includes("offer pushed to landing"))),
         "landing never observed the pushed offer");
  assert(await page.evaluate(() => window.PLEXCAST_POLLS === undefined),
         "receiver unexpectedly started the old polling loop");
  sender.socket.close();

  const outage = await context.newPage();
  await outage.goto(`${receiverOrigin}/?sig=${encodeURIComponent("http://127.0.0.1:1")}`);
  await outage.locator("#signal-error").filter({ hasText: "Signaling is unavailable" }).waitFor({ timeout: 10_000 });
  console.log("receiver browser signaling smoke test passed");
} catch (error) {
  if (workerLog) console.error(workerLog.slice(-4_000));
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => staticServer?.close(resolve));
  worker?.kill("SIGTERM");
}

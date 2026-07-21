import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SignalRoom } from "../src/index";

type Message = Record<string, unknown>;
const queues = new WeakMap<WebSocket, Message[]>();
const waiters = new WeakMap<WebSocket, Array<(message: Message) => void>>();

function track(socket: WebSocket): void {
  queues.set(socket, []);
  waiters.set(socket, []);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    const waiter = waiters.get(socket)?.shift();
    if (waiter) waiter(message);
    else queues.get(socket)?.push(message);
  });
}

function nextMessage(socket: WebSocket): Promise<Message> {
  const queued = queues.get(socket)?.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), 2_000);
    waiters.get(socket)?.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

async function openSocket(room: string, role: "sender" | "viewer", session: string) {
  const response = await exports.default.fetch(new Request(
    `https://signal.test/rtc/ws/${room}?role=${role}&session=${session}`,
    { headers: { Upgrade: "websocket" } },
  ));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).not.toBeNull();
  track(socket!);
  const ready = nextMessage(socket!);
  socket!.accept();
  expect(await ready).toMatchObject({ type: "ready", role, protocol: 1 });
  return socket!;
}

describe("signal worker", () => {
  it("serves health and returns CORS on validation errors", async () => {
    const health = await exports.default.fetch("https://signal.test/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, protocol: 1 });

    const invalid = await exports.default.fetch("https://signal.test/rtc/offer/bad.room");
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await invalid.json()).toMatchObject({ error: "invalid_room" });
  });

  it("relays an offer to a late viewer and rejects a stale answer", async () => {
    const sender = await openSocket("late-viewer", "sender", "sender-a");
    expect(await nextMessage(sender)).toMatchObject({ type: "viewerPresence", online: false });

    sender.send(JSON.stringify({ type: "offer", generation: "generation-a", sdp: "offer-a" }));
    expect(await nextMessage(sender)).toMatchObject({ type: "ack", action: "offer", generation: "generation-a" });

    const viewer = await openSocket("late-viewer", "viewer", "viewer-a");
    expect(await nextMessage(viewer)).toEqual({ type: "offer", generation: "generation-a", sdp: "offer-a" });
    expect(await nextMessage(sender)).toMatchObject({ type: "viewerPresence", online: true, count: 1 });

    viewer.send(JSON.stringify({ type: "answer", generation: "generation-old", sdp: "wrong" }));
    expect(await nextMessage(viewer)).toMatchObject({ type: "error", code: "stale_generation" });

    viewer.send(JSON.stringify({ type: "answer", generation: "generation-a", sdp: "answer-a" }));
    expect(await nextMessage(viewer)).toMatchObject({ type: "ack", action: "answer" });
    expect(await nextMessage(sender)).toEqual({ type: "answer", generation: "generation-a", sdp: "answer-a" });

    viewer.close(1000, "done");
    sender.close(1000, "done");
  });

  it("allows a same-session replacement but rejects another sender", async () => {
    const sender = await openSocket("owned-room", "sender", "owner");
    await nextMessage(sender);

    const collision = await exports.default.fetch(new Request(
      "https://signal.test/rtc/ws/owned-room?role=sender&session=intruder",
      { headers: { Upgrade: "websocket" } },
    ));
    expect(collision.status).toBe(409);
    expect(collision.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await collision.json()).toMatchObject({ error: "room_busy" });

    const replacement = await openSocket("owned-room", "sender", "owner");
    await nextMessage(replacement);
    replacement.send(JSON.stringify({ type: "offer", generation: "replacement-gen", sdp: "fresh" }));
    expect(await nextMessage(replacement)).toMatchObject({ type: "ack", generation: "replacement-gen" });
    replacement.close(1000, "done");
  });

  it("supports the legacy HTTP handshake", async () => {
    const put = await exports.default.fetch(new Request("https://signal.test/rtc/offer/legacy-room", {
      method: "PUT", body: "legacy-offer",
    }));
    expect(put.status).toBe(200);
    await put.text();

    const offer = await exports.default.fetch(new Request("https://signal.test/rtc/offer/legacy-room", {
      headers: { Origin: "https://tv.rikard.dev" },
    }));
    expect(await offer.text()).toBe("legacy-offer");

    const post = await exports.default.fetch(new Request("https://signal.test/rtc/answer/legacy-room", {
      method: "POST", body: "legacy-answer",
    }));
    expect(post.status).toBe(200);
    await post.text();

    const answer = await exports.default.fetch("https://signal.test/rtc/answer/legacy-room");
    expect(await answer.text()).toBe("legacy-answer");
    const consumed = await exports.default.fetch("https://signal.test/rtc/answer/legacy-room");
    expect(consumed.status).toBe(404);
    await consumed.text();
  });

  it("bridges a WebSocket sender to an old HTTP viewer", async () => {
    const sender = await openSocket("new-sender-old-viewer", "sender", "sender-bridge");
    await nextMessage(sender);
    sender.send(JSON.stringify({ type: "offer", generation: "bridge-gen", sdp: "bridge-offer" }));
    await nextMessage(sender);

    const offer = await exports.default.fetch(new Request(
      "https://signal.test/rtc/offer/new-sender-old-viewer",
      { headers: { Origin: "https://tv.rikard.dev" } },
    ));
    expect(await offer.text()).toBe("bridge-offer");

    const posted = await exports.default.fetch(new Request(
      "https://signal.test/rtc/answer/new-sender-old-viewer",
      { method: "POST", body: "bridge-answer" },
    ));
    expect(posted.status).toBe(200);
    await posted.text();
    expect(await nextMessage(sender)).toEqual({ type: "answer", generation: "bridge-gen", sdp: "bridge-answer" });
    sender.close(1000, "done");
  });

  it("bridges an old HTTP sender to a WebSocket viewer", async () => {
    const viewer = await openSocket("old-sender-new-viewer", "viewer", "viewer-bridge");
    const put = await exports.default.fetch(new Request(
      "https://signal.test/rtc/offer/old-sender-new-viewer",
      { method: "PUT", body: "old-offer" },
    ));
    await put.text();
    const offer = await nextMessage(viewer);
    expect(offer).toMatchObject({ type: "offer", sdp: "old-offer" });

    viewer.send(JSON.stringify({ type: "answer", generation: offer.generation, sdp: "new-answer" }));
    await nextMessage(viewer);
    const answer = await exports.default.fetch("https://signal.test/rtc/answer/old-sender-new-viewer");
    expect(await answer.text()).toBe("new-answer");
    viewer.close(1000, "done");
  });

  it("tracks socket presence and isolates old browser beacons from offers", async () => {
    const viewer = await openSocket("presence-room", "viewer", "presence-viewer");
    let presence = await exports.default.fetch("https://signal.test/rtc/presence/presence-room");
    expect(await presence.json()).toEqual({ online: true });

    const oldAppPresence = await exports.default.fetch("https://signal.test/rtc/offer/p-presence-room");
    expect(await oldAppPresence.text()).toBe("1");
    viewer.close(1000, "done");

    const beacon = await exports.default.fetch(new Request("https://signal.test/rtc/offer/p-old-token", {
      method: "PUT", body: "1", headers: { Origin: "https://tv.rikard.dev" },
    }));
    await beacon.text();
    const browserPoll = await exports.default.fetch(new Request("https://signal.test/rtc/offer/p-old-token", {
      headers: { Origin: "https://tv.rikard.dev" },
    }));
    expect(browserPoll.status).toBe(404);
    await browserPoll.text();
    presence = await exports.default.fetch("https://signal.test/rtc/presence/p-old-token");
    expect(await presence.json()).toEqual({ online: true });

    const clear = await exports.default.fetch(new Request("https://signal.test/rtc/offer/p-old-token", {
      method: "POST", body: "", headers: { Origin: "https://tv.rikard.dev" },
    }));
    await clear.text();
    presence = await exports.default.fetch("https://signal.test/rtc/presence/p-old-token");
    expect(await presence.json()).toEqual({ online: false });
  });

  it("cleans expired signal state through the alarm path", async () => {
    const put = await exports.default.fetch(new Request("https://signal.test/rtc/offer/expiry-room", {
      method: "PUT", body: "expiring-offer",
    }));
    await put.text();
    const rooms = (env as unknown as { ROOMS: DurableObjectNamespace<SignalRoom> }).ROOMS;
    await rooms.getByName("room:expiry-room").cleanupExpired(Number.MAX_SAFE_INTEGER);

    const expired = await exports.default.fetch("https://signal.test/rtc/offer/expiry-room");
    expect(expired.status).toBe(404);
    await expired.text();
  });
});

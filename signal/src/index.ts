import { DurableObject } from "cloudflare:workers";

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PAYLOAD_LIMIT = 100_000;
const SIGNAL_TTL_MS = 5 * 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface Env {
  ROOMS: DurableObjectNamespace<SignalRoom>;
}

type Role = "sender" | "viewer";

interface SocketAttachment {
  role: Role;
  session: string;
  replaced?: boolean;
}

interface SignalState {
  offer: string | null;
  offerGeneration: string | null;
  answer: string | null;
  answerGeneration: string | null;
  selectedViewer: string | null;
  expiresAt: number | null;
  legacyPresenceExpiresAt: number | null;
}

type ClientMessage =
  | { type: "offer"; generation: string; sdp: string }
  | { type: "answer"; generation: string; sdp: string }
  | { type: "clear"; generation?: string }
  | { type: "answerApplied"; generation: string };

function response(body: BodyInit | null, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, { status, headers: { ...CORS, ...headers } });
}

function json(body: unknown, status = 200): Response {
  return response(JSON.stringify(body), status, { "Content-Type": "application/json" });
}

function errorResponse(code: string, message: string, status: number): Response {
  return json({ error: code, message }, status);
}

function validGeneration(value: unknown): value is string {
  return typeof value === "string" && SESSION_RE.test(value);
}

function payloadSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
    if (request.method === "OPTIONS") return response(null, 204);

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "plexcast-signal", protocol: 1 });
    }

    const wsMatch = url.pathname.match(/^\/rtc\/ws\/([^/]+)$/);
    if (wsMatch) {
      if (request.method !== "GET") return errorResponse("method_not_allowed", "WebSocket rooms use GET", 405);
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return errorResponse("upgrade_required", "Expected a WebSocket upgrade", 426);
      }
      const room = wsMatch[1];
      if (!ROOM_RE.test(room)) return errorResponse("invalid_room", "Invalid room", 400);
      return env.ROOMS.getByName(`room:${room}`).fetch(request);
    }

    const presenceMatch = url.pathname.match(/^\/rtc\/presence\/([^/]+)$/);
    if (presenceMatch) {
      if (request.method !== "GET") return errorResponse("method_not_allowed", "Presence uses GET", 405);
      const room = presenceMatch[1];
      if (!ROOM_RE.test(room)) return errorResponse("invalid_room", "Invalid room", 400);
      const checks = [env.ROOMS.getByName(`room:${room}`).presence()];
      if (!room.startsWith("p-")) {
        checks.push(env.ROOMS.getByName(`room:p-${room}`).presence());
      }
      return json({ online: (await Promise.all(checks)).some(Boolean) });
    }

    const legacyMatch = url.pathname.match(/^\/rtc\/(offer|answer)\/([^/]+)$/);
    if (!legacyMatch) return errorResponse("not_found", "Not found", 404);
    const [, kind, encodedRoom] = legacyMatch;
    const room = encodedRoom;
    if (!ROOM_RE.test(room)) return errorResponse("invalid_room", "Invalid room", 400);

    const stub = env.ROOMS.getByName(`room:${room}`);
    const browserOrigin = request.headers.has("Origin");

    if ((request.method === "PUT" || request.method === "POST") && kind === "offer") {
      const body = await request.text();
      if (payloadSize(body) > PAYLOAD_LIMIT) return errorResponse("payload_too_large", "Payload exceeds 100 KB", 413);
      // Receiver versions before protocol v1 used offer/p-<token> as a presence
      // beacon. Keep that state independent from the real offer so a browser
      // cannot answer its own marker and so it no longer costs KV writes.
      if (browserOrigin && room.startsWith("p-") && (body === "1" || body === "")) {
        await stub.setLegacyPresence(body === "1");
      } else {
        await stub.putLegacyOffer(body);
      }
      return response("ok");
    }

    if (request.method === "POST" && kind === "answer") {
      const body = await request.text();
      if (payloadSize(body) > PAYLOAD_LIMIT) return errorResponse("payload_too_large", "Payload exceeds 100 KB", 413);
      const accepted = await stub.putLegacyAnswer(body);
      if (!accepted) return errorResponse("no_offer", "No current offer", 409);
      return response("ok");
    }

    if (request.method === "GET" && kind === "offer") {
      let value = await stub.getLegacyOffer(browserOrigin);
      // Old apps discover a paired page through offer/p-<token>. A new page's
      // actual listener lives in <token>, so bridge its socket presence here.
      if (value === null && !browserOrigin && room.startsWith("p-") && room.length > 2) {
        const online = await env.ROOMS.getByName(`room:${room.slice(2)}`).presence();
        if (online) value = "1";
      }
      return value === null ? response("", 404) : response(value, 200, { "Content-Type": "text/plain" });
    }

    if (request.method === "GET" && kind === "answer") {
      const value = await stub.takeLegacyAnswer();
      return value === null ? response("", 404) : response(value, 200, { "Content-Type": "text/plain" });
    }

    return errorResponse("method_not_allowed", "Method not allowed", 405);
    } catch (error) {
      console.error(JSON.stringify({
        event: "request_failed",
        method: request.method,
        error: error instanceof Error ? error.name : "unknown",
      }));
      return errorResponse("internal_error", "The signaling service could not complete the request", 500);
    }
  },
} satisfies ExportedHandler<Env>;

export class SignalRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS signal_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          offer TEXT,
          offer_generation TEXT,
          answer TEXT,
          answer_generation TEXT,
          selected_viewer TEXT,
          expires_at INTEGER,
          legacy_presence_expires_at INTEGER
        )
      `);
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO signal_state (id) VALUES (1)");
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const session = url.searchParams.get("session");
    if ((role !== "sender" && role !== "viewer") || !session || !SESSION_RE.test(session)) {
      return errorResponse("invalid_socket", "role and session are required", 400);
    }

    const existing = this.sockets(role);
    for (const socket of existing) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (role === "sender" && attachment?.session !== session) {
        return errorResponse("room_busy", "Another sender owns this room", 409);
      }
      if (attachment?.session === session) {
        socket.serializeAttachment({ ...attachment, replaced: true } satisfies SocketAttachment);
        socket.close(4000, "replaced");
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ role, session } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server, [role]);
    console.log(JSON.stringify({ event: "socket_open", role }));

    this.send(server, { type: "ready", protocol: 1, role });
    if (role === "viewer") {
      this.notifyViewerPresence();
      this.assignOfferIfPossible();
    } else {
      this.send(server, { type: "viewerPresence", online: this.sockets("viewer").length > 0,
                          count: this.sockets("viewer").length });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async presence(): Promise<boolean> {
    const state = this.state();
    return this.sockets("viewer").length > 0 || (state.legacyPresenceExpiresAt ?? 0) > Date.now();
  }

  async setLegacyPresence(online: boolean): Promise<void> {
    const expiresAt = online ? Date.now() + SIGNAL_TTL_MS : null;
    this.ctx.storage.sql.exec(
      "UPDATE signal_state SET legacy_presence_expires_at = ? WHERE id = 1",
      expiresAt,
    );
    await this.scheduleCleanup();
    this.notifyViewerPresence();
  }

  async putLegacyOffer(offer: string): Promise<void> {
    if (!offer) {
      this.clearSignalState();
      return;
    }
    const generation = crypto.randomUUID();
    this.storeOffer(offer, generation);
    this.assignOfferIfPossible();
    await this.scheduleCleanup();
  }

  async getLegacyOffer(browserOrigin: boolean): Promise<string | null> {
    const state = this.freshState();
    if (state.offer) return state.offer;
    // Native legacy senders used this GET to discover old-browser presence.
    if (!browserOrigin && (state.legacyPresenceExpiresAt ?? 0) > Date.now()) return "1";
    return null;
  }

  async putLegacyAnswer(answer: string): Promise<boolean> {
    const state = this.freshState();
    if (!state.offerGeneration || !answer) return false;
    this.storeAnswer(answer, state.offerGeneration);
    this.sendToRole("sender", { type: "answer", generation: state.offerGeneration, sdp: answer });
    await this.scheduleCleanup();
    return true;
  }

  async takeLegacyAnswer(): Promise<string | null> {
    const state = this.freshState();
    if (!state.answer) return null;
    this.ctx.storage.sql.exec(
      "UPDATE signal_state SET answer = NULL, answer_generation = NULL WHERE id = 1",
    );
    return state.answer;
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return this.closeWithError(socket, "invalid_socket", "Missing socket metadata");
    if (typeof message !== "string" || payloadSize(message) > PAYLOAD_LIMIT) {
      return this.closeWithError(socket, "payload_too_large", "Messages must be text under 100 KB", 1009);
    }

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      return this.send(socket, { type: "error", code: "invalid_json", message: "Invalid JSON" });
    }

    if (attachment.role === "sender") await this.handleSenderMessage(socket, parsed);
    else await this.handleViewerMessage(socket, attachment, parsed);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    void code; void reason; void wasClean;
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.replaced) return;
    if (attachment) console.log(JSON.stringify({ event: "socket_close", role: attachment.role }));
    if (attachment?.role === "sender") {
      this.clearSignalState();
      return;
    }
    if (attachment?.role === "viewer") {
      const state = this.state();
      if (state.selectedViewer === attachment.session) {
        this.ctx.storage.sql.exec("UPDATE signal_state SET selected_viewer = NULL WHERE id = 1");
        this.assignOfferIfPossible();
      }
      this.notifyViewerPresence();
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "socket error");
  }

  async alarm(): Promise<void> {
    await this.cleanupExpired(Date.now());
  }

  async cleanupExpired(now: number): Promise<void> {
    const state = this.state();
    if ((state.expiresAt ?? 0) <= now) this.clearSignalState();
    if ((state.legacyPresenceExpiresAt ?? 0) <= now) {
      this.ctx.storage.sql.exec(
        "UPDATE signal_state SET legacy_presence_expires_at = NULL WHERE id = 1",
      );
    }
    await this.scheduleCleanup();
  }

  private async handleSenderMessage(socket: WebSocket, message: ClientMessage): Promise<void> {
    if (message.type === "offer") {
      if (!validGeneration(message.generation) || typeof message.sdp !== "string" ||
          !message.sdp || payloadSize(message.sdp) > PAYLOAD_LIMIT) {
        return this.send(socket, { type: "error", code: "invalid_offer", message: "Invalid offer" });
      }
      this.storeOffer(message.sdp, message.generation);
      this.assignOfferIfPossible();
      await this.scheduleCleanup();
      return this.send(socket, { type: "ack", action: "offer", generation: message.generation });
    }
    if (message.type === "clear") {
      const state = this.state();
      if (!message.generation || state.offerGeneration === message.generation) this.clearSignalState();
      return this.send(socket, { type: "ack", action: "clear", generation: message.generation ?? null });
    }
    if (message.type === "answerApplied") {
      const state = this.state();
      if (state.answerGeneration === message.generation) {
        this.ctx.storage.sql.exec(
          "UPDATE signal_state SET offer = NULL, answer = NULL, answer_generation = NULL WHERE id = 1",
        );
      }
      return this.send(socket, { type: "ack", action: "answerApplied", generation: message.generation });
    }
    this.send(socket, { type: "error", code: "invalid_message", message: "Sender message not allowed" });
  }

  private async handleViewerMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: ClientMessage,
  ): Promise<void> {
    if (message.type !== "answer" || !validGeneration(message.generation) ||
        typeof message.sdp !== "string" || !message.sdp || payloadSize(message.sdp) > PAYLOAD_LIMIT) {
      return this.send(socket, { type: "error", code: "invalid_answer", message: "Invalid answer" });
    }
    const state = this.freshState();
    if (state.offerGeneration !== message.generation || state.selectedViewer !== attachment.session) {
      return this.send(socket, { type: "error", code: "stale_generation", message: "Offer is no longer current" });
    }
    this.storeAnswer(message.sdp, message.generation);
    this.sendToRole("sender", { type: "answer", generation: message.generation, sdp: message.sdp });
    await this.scheduleCleanup();
    this.send(socket, { type: "ack", action: "answer", generation: message.generation });
  }

  private state(): SignalState {
    const row = [...this.ctx.storage.sql.exec<{
      offer: string | null;
      offer_generation: string | null;
      answer: string | null;
      answer_generation: string | null;
      selected_viewer: string | null;
      expires_at: number | null;
      legacy_presence_expires_at: number | null;
    }>("SELECT * FROM signal_state WHERE id = 1")][0];
    return {
      offer: row.offer,
      offerGeneration: row.offer_generation,
      answer: row.answer,
      answerGeneration: row.answer_generation,
      selectedViewer: row.selected_viewer,
      expiresAt: row.expires_at,
      legacyPresenceExpiresAt: row.legacy_presence_expires_at,
    };
  }

  private freshState(): SignalState {
    const state = this.state();
    if ((state.expiresAt ?? Number.MAX_SAFE_INTEGER) <= Date.now()) {
      this.clearSignalState();
      return this.state();
    }
    return state;
  }

  private storeOffer(offer: string, generation: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE signal_state
       SET offer = ?, offer_generation = ?, answer = NULL, answer_generation = NULL,
           selected_viewer = NULL, expires_at = ?
       WHERE id = 1`,
      offer, generation, Date.now() + SIGNAL_TTL_MS,
    );
  }

  private storeAnswer(answer: string, generation: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE signal_state
       SET answer = ?, answer_generation = ?, expires_at = ?
       WHERE id = 1`,
      answer, generation, Date.now() + SIGNAL_TTL_MS,
    );
  }

  private clearSignalState(): void {
    this.ctx.storage.sql.exec(
      `UPDATE signal_state
       SET offer = NULL, offer_generation = NULL, answer = NULL,
           answer_generation = NULL, selected_viewer = NULL, expires_at = NULL
       WHERE id = 1`,
    );
  }

  private sockets(role: Role): WebSocket[] {
    return this.ctx.getWebSockets(role);
  }

  private assignOfferIfPossible(): void {
    const state = this.freshState();
    if (!state.offer || !state.offerGeneration) return;
    const viewers = this.sockets("viewer");
    if (!viewers.length) return;

    let selected = state.selectedViewer;
    let selectedSocket = viewers.find((socket) =>
      (socket.deserializeAttachment() as SocketAttachment | null)?.session === selected);
    if (!selectedSocket) {
      selectedSocket = viewers[0];
      selected = (selectedSocket.deserializeAttachment() as SocketAttachment).session;
      this.ctx.storage.sql.exec("UPDATE signal_state SET selected_viewer = ? WHERE id = 1", selected);
    }
    this.send(selectedSocket, { type: "offer", generation: state.offerGeneration, sdp: state.offer });
  }

  private notifyViewerPresence(): void {
    const socketCount = this.sockets("viewer").length;
    const state = this.state();
    const legacy = (state.legacyPresenceExpiresAt ?? 0) > Date.now();
    this.sendToRole("sender", {
      type: "viewerPresence",
      online: socketCount > 0 || legacy,
      count: socketCount + (legacy ? 1 : 0),
    });
  }

  private sendToRole(role: Role, value: unknown): void {
    for (const socket of this.sockets(role)) this.send(socket, value);
  }

  private send(socket: WebSocket, value: unknown): void {
    try { socket.send(JSON.stringify(value)); } catch { /* closed between lookup and send */ }
  }

  private closeWithError(socket: WebSocket, code: string, message: string, closeCode = 1008): void {
    this.send(socket, { type: "error", code, message });
    socket.close(closeCode, message.slice(0, 120));
  }

  private async scheduleCleanup(): Promise<void> {
    const state = this.state();
    const deadlines = [state.expiresAt, state.legacyPresenceExpiresAt]
      .filter((value): value is number => value !== null && value > Date.now());
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
  }
}

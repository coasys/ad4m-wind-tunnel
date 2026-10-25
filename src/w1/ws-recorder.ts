/**
 * W1 helper: record every WebSocket frame (and HTTP request) a page exchanges with the executor,
 * from the browser's own network layer via the Chrome DevTools Protocol.
 *
 * CDP events used: Network.webSocketCreated / webSocketHandshakeResponseReceived /
 * webSocketFrameSent / webSocketFrameReceived / webSocketFrameError / webSocketClosed, plus
 * Network.requestWillBeSent / responseReceived / loadingFinished for plain HTTP to the executor.
 *
 * The ad4m WS-RPC wire (ad4m core/src/apiClient.ts):
 *   request  → `{ id, type: <method>, params }`
 *   response ← `{ id, result }` | `{ id, error }`   (no `type`)
 *   event    ← `{ type: <event name>, perspectiveUuid?, ... }`
 *   keepalive `{ type: "ping" }` → `{ type: "pong" }`
 * Requests and responses are paired by `id` per socket; latency is the difference of the two
 * frames' CDP timestamps (the browser's network clock, not JS scheduling).
 */

import { createHash } from "crypto";
import type { CDPSession } from "playwright-core";

export type FrameKind = "request" | "response" | "event" | "ping" | "pong" | "other";

export interface FrameRecord {
  /** ms since the recorder started (browser network clock). */
  t: number;
  phase: string;
  socket: string;
  dir: "sent" | "recv";
  bytes: number;
  kind: FrameKind;
  id?: string;
  method?: string;
  event?: string;
  perspective?: string;
  error?: boolean;
}

export interface RpcCall {
  id: string;
  socket: string;
  phase: string;
  method: string;
  /** ms since recorder start. */
  sentAt: number;
  recvAt?: number;
  latencyMs?: number;
  paramsBytes: number;
  responseBytes?: number;
  /** sha1 (12 hex) of the method + canonical params JSON — equal hash = identical call. */
  callHash: string;
  /** First 400 chars of the params JSON, for naming duplicates in the report. */
  paramsPreview: string;
  /** The params themselves when their JSON is at most 4 KB, so a call can be replayed. */
  params?: unknown;
  error?: string;
}

export interface SocketRecord {
  requestId: string;
  url: string;
  /** Token stripped. */
  safeUrl: string;
  phase: string;
  createdAt: number;
  handshakeAt?: number;
  closedAt?: number;
  executor: boolean;
  framesSent: number;
  framesRecv: number;
  bytesSent: number;
  bytesRecv: number;
}

export interface HttpRecord {
  t: number;
  phase: string;
  method: string;
  path: string;
  status?: number;
  bytes?: number;
}

/** Stable JSON: object keys sorted, so the same params always hash the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function stripToken(url: string): string {
  return url.replace(/([?&]token=)[^&]*/i, "$1<redacted>");
}

export class WsRecorder {
  readonly frames: FrameRecord[] = [];
  readonly calls: RpcCall[] = [];
  readonly sockets = new Map<string, SocketRecord>();
  readonly http: HttpRecord[] = [];
  /** Frames that failed to parse as JSON. */
  unparsed = 0;
  private phase = "boot";
  private t0: number | null = null;
  private pending = new Map<string, RpcCall>();
  private httpPending = new Map<string, HttpRecord>();
  private wallStart = Date.now();

  constructor(private readonly executorPort: number) {}

  /** Subsequent frames are attributed to `name`. A call belongs to the phase it was sent in. */
  setPhase(name: string): void {
    this.phase = name;
  }

  get currentPhase(): string {
    return this.phase;
  }

  /** ms on the recorder clock, for marking phase boundaries from the driver side. */
  nowMs(): number {
    return Date.now() - this.wallStart;
  }

  private isExecutorUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return Number(u.port) === this.executorPort && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    } catch {
      return false;
    }
  }

  /** CDP timestamps are seconds on a monotonic clock; anchor the first one to the wall start. */
  private ts(cdpSeconds: number): number {
    if (this.t0 === null) this.t0 = cdpSeconds * 1000 - (Date.now() - this.wallStart);
    return cdpSeconds * 1000 - this.t0;
  }

  async attach(cdp: CDPSession): Promise<void> {
    cdp.on("Network.webSocketCreated", (e: any) => {
      this.sockets.set(e.requestId, {
        requestId: e.requestId,
        url: e.url,
        safeUrl: stripToken(e.url),
        phase: this.phase,
        createdAt: this.nowMs(),
        executor: this.isExecutorUrl(e.url),
        framesSent: 0,
        framesRecv: 0,
        bytesSent: 0,
        bytesRecv: 0,
      });
    });
    cdp.on("Network.webSocketHandshakeResponseReceived", (e: any) => {
      const s = this.sockets.get(e.requestId);
      if (s) s.handshakeAt = this.ts(e.timestamp);
    });
    cdp.on("Network.webSocketClosed", (e: any) => {
      const s = this.sockets.get(e.requestId);
      if (s) s.closedAt = this.ts(e.timestamp);
    });
    cdp.on("Network.webSocketFrameSent", (e: any) => this.onFrame("sent", e));
    cdp.on("Network.webSocketFrameReceived", (e: any) => this.onFrame("recv", e));

    cdp.on("Network.requestWillBeSent", (e: any) => {
      if (!this.isExecutorUrl(e.request.url)) return;
      const u = new URL(e.request.url);
      const rec: HttpRecord = { t: this.nowMs(), phase: this.phase, method: e.request.method, path: u.pathname };
      this.http.push(rec);
      this.httpPending.set(e.requestId, rec);
    });
    cdp.on("Network.responseReceived", (e: any) => {
      const rec = this.httpPending.get(e.requestId);
      if (rec) rec.status = e.response.status;
    });
    cdp.on("Network.loadingFinished", (e: any) => {
      const rec = this.httpPending.get(e.requestId);
      if (rec) {
        rec.bytes = e.encodedDataLength;
        this.httpPending.delete(e.requestId);
      }
    });

    await cdp.send("Network.enable", { maxPostDataSize: 0 });
  }

  private onFrame(dir: "sent" | "recv", e: any): void {
    const socket = this.sockets.get(e.requestId);
    if (!socket || !socket.executor) return;
    const payload: string = e.response?.payloadData ?? "";
    const opcode: number = e.response?.opcode ?? 1;
    const t = this.ts(e.timestamp);
    const bytes = opcode === 1 ? utf8Bytes(payload) : Math.floor((payload.length * 3) / 4); // binary frames arrive base64
    if (dir === "sent") {
      socket.framesSent++;
      socket.bytesSent += bytes;
    } else {
      socket.framesRecv++;
      socket.bytesRecv += bytes;
    }
    const frame: FrameRecord = { t, phase: this.phase, socket: e.requestId, dir, bytes, kind: "other" };
    this.frames.push(frame);
    if (opcode !== 1) return;

    let msg: any;
    try {
      msg = JSON.parse(payload);
    } catch {
      this.unparsed++;
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (dir === "sent") {
      if (msg.type === "ping") {
        frame.kind = "ping";
        return;
      }
      if (msg.id !== undefined && typeof msg.type === "string") {
        frame.kind = "request";
        frame.id = String(msg.id);
        frame.method = msg.type;
        const paramsJson = canonical(msg.params ?? {});
        const call: RpcCall = {
          id: String(msg.id),
          socket: e.requestId,
          phase: this.phase,
          method: msg.type,
          sentAt: t,
          paramsBytes: utf8Bytes(paramsJson),
          callHash: createHash("sha1").update(`${msg.type}\n${paramsJson}`).digest("hex").slice(0, 12),
          paramsPreview: paramsJson.slice(0, 400),
          ...(paramsJson.length <= 4096 ? { params: msg.params ?? {} } : {}),
        };
        this.calls.push(call);
        this.pending.set(`${e.requestId}:${call.id}`, call);
      }
      return;
    }

    // received
    if (msg.type === undefined && msg.id !== undefined) {
      frame.kind = "response";
      frame.id = String(msg.id);
      const call = this.pending.get(`${e.requestId}:${frame.id}`);
      if (call) {
        this.pending.delete(`${e.requestId}:${frame.id}`);
        call.recvAt = t;
        call.latencyMs = t - call.sentAt;
        call.responseBytes = bytes;
        frame.method = call.method;
        if (msg.error) {
          frame.error = true;
          call.error = String(msg.error.message ?? JSON.stringify(msg.error)).slice(0, 200);
        }
      }
      return;
    }
    if (msg.type === "pong") {
      frame.kind = "pong";
      return;
    }
    if (typeof msg.type === "string") {
      frame.kind = "event";
      frame.event = msg.type;
      if (typeof msg.perspectiveUuid === "string") frame.perspective = msg.perspectiveUuid;
    }
  }

  /** Calls still waiting for a response. */
  get unanswered(): RpcCall[] {
    return [...this.pending.values()];
  }
}

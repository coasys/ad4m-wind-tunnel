/**
 * Clients for f1 that behave like the AD4M SDK on the wire, with counters.
 *
 * Mirrors @coasys/ad4m (core/src/apiClient.ts, perspectives/PerspectiveClient.ts,
 * perspectives/LiveQuery.ts at ad4m dev 4226948b1):
 *  - every call has a timeout (30 s default);
 *  - a call that opens something (`perspective.subscribeQuery`) that times out
 *    sends `request.cancel {targetId}`; other calls that time out are left to run;
 *  - subscription ids are minted by the client (#1685), and a subscribe that
 *    fails or times out is disposed by id without its reply (#1680);
 *  - a `query-subscription-update` with a revision gap, or `{lagged:true}`,
 *    triggers `perspective.resyncSubscription`; a failed resync disposes and
 *    re-opens;
 *  - the app re-opens a live query whose subscribe failed, after the SDK's
 *    `reopenDelay` backoff (1 s doubling, jittered, capped at 60 s).
 *
 * `legacy` mode is a client from before those fixes: no `request.cancel`, no
 * dispose of a subscribe that timed out, and an immediate re-subscribe. On the
 * executor that subscribe still runs, registers, and re-runs on every write
 * for nobody until the socket closes.
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";

export type ClientMode = "sdk" | "legacy";

export const REOPEN_BASE_DELAY_MS = 1000;
export const REOPEN_MAX_DELAY_MS = 60_000;

/** The SDK's `reopenDelay` (LiveQuery.ts). */
export function reopenDelay(failures: number, random: () => number = Math.random): number {
  const ceiling = Math.min(REOPEN_BASE_DELAY_MS * 2 ** Math.max(0, failures - 1), REOPEN_MAX_DELAY_MS);
  return ceiling / 2 + (random() * ceiling) / 2;
}

const OPENS_METHODS = new Set(["perspective.subscribeQuery", "perspective.modelSubscribe"]);

export interface CallSample {
  method: string;
  /** Date.now() when sent / when settled */
  sentAt: number;
  doneAt: number;
  ms: number;
  outcome: "ok" | "error" | "timeout";
  error?: string;
}

/** Counters shared by every client of one run. */
export class RunCounters {
  inflight = 0;
  timeouts = 0;
  errors = 0;
  resubscribes = 0;
  resyncs = 0;
  lagged = 0;
  liveSubs = 0;
  /** `request.cancel` sent for a timed-out subscribe (sdk mode). */
  subCancels = 0;
  calls: CallSample[] = [];
  /** write-to-visible: one per (client, written line) first seen. */
  visible: Array<{ at: number; ms: number }> = [];
}

export class RpcSocket {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout; method: string; sentAt: number }>();
  private listeners = new Set<(msg: any) => void>();
  closed = false;

  constructor(
    private readonly url: string,
    private readonly mode: ClientMode,
    private readonly counters: RunCounters,
    private readonly defaultTimeoutMs: number
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: 512 * 1024 * 1024 });
      this.ws = ws;
      ws.on("open", () => resolve());
      ws.on("error", (e) => reject(e));
      ws.on("message", (data) => this.onMessage(data.toString()));
      ws.on("close", () => {
        this.closed = true;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("WebSocket closed"));
        }
        this.counters.inflight -= this.pending.size;
        this.pending.clear();
      });
    });
  }

  onEvent(fn: (msg: any) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private onMessage(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.id !== null && this.pending.has(String(msg.id))) {
      const p = this.pending.get(String(msg.id))!;
      this.pending.delete(String(msg.id));
      clearTimeout(p.timer);
      this.counters.inflight--;
      const now = Date.now();
      if (msg.error) {
        this.counters.errors++;
        const err = msg.error.message || JSON.stringify(msg.error);
        this.counters.calls.push({ method: p.method, sentAt: p.sentAt, doneAt: now, ms: now - p.sentAt, outcome: "error", error: String(err).slice(0, 200) });
        p.reject(new Error(err));
      } else {
        this.counters.calls.push({ method: p.method, sentAt: p.sentAt, doneAt: now, ms: now - p.sentAt, outcome: "ok" });
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.type) for (const l of this.listeners) l(msg);
  }

  /** Send without tracking a reply (request.cancel). */
  private sendRaw(obj: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  call<T = any>(method: string, params: any, opts: { timeoutMs?: number; record?: boolean } = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("WebSocket not connected"));
    const id = `c${++this.seq}`;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const sentAt = Date.now();
    this.counters.inflight++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.counters.inflight--;
        this.counters.timeouts++;
        const now = Date.now();
        this.counters.calls.push({ method, sentAt, doneAt: now, ms: now - sentAt, outcome: "timeout" });
        if (this.mode === "sdk" && OPENS_METHODS.has(method)) {
          this.counters.subCancels++;
          this.sendRaw({ id: `x${++this.seq}`, type: "request.cancel", params: { targetId: id } });
        }
        reject(new TimeoutError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, sentAt });
      this.ws!.send(JSON.stringify({ id, type: method, params }));
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
  }
}

export class TimeoutError extends Error {}

/**
 * One live SPARQL query held by an app. Re-opens on failure like an app on the
 * SDK does (see the file comment); `onRows` sees every result and every
 * `added` set, so the caller can time write-to-visible.
 */
export class LiveSub {
  private id: string | null = null;
  private revision = 0;
  private disposed = false;
  private failures = 0;
  private retry: NodeJS.Timeout | null = null;
  private unlisten: () => void;
  private live = false;
  private opening = false;
  opens = 0;

  constructor(
    private readonly sock: RpcSocket,
    private readonly uuid: string,
    private readonly query: string,
    private readonly mode: ClientMode,
    private readonly counters: RunCounters,
    private readonly onRows?: (rows: unknown) => void
  ) {
    this.unlisten = sock.onEvent((msg) => this.receive(msg));
  }

  start(): void {
    if (this.disposed || this.opening) return;
    this.opening = true;
    if (this.opens > 0) this.counters.resubscribes++;
    this.opens++;
    const subscriptionId = randomUUID();
    this.sock
      .call<any>("perspective.subscribeQuery", { uuid: this.uuid, query: this.query, subscriptionId })
      .then((r) => {
        this.opening = false;
        if (this.disposed) {
          this.sock.call("perspective.disposeQuery", { uuid: this.uuid, subscriptionId }).catch(() => {});
          return;
        }
        this.failures = 0;
        this.id = r?.subscriptionId ?? subscriptionId;
        this.revision = r?.revision ?? 0;
        this.setLive(true);
        this.onRows?.(r?.result);
      })
      .catch(() => {
        this.opening = false;
        this.setLive(false);
        if (this.disposed) return;
        if (this.mode === "sdk") {
          // #1680/#1685: the client minted the id, so it can end the subscription without the reply.
          this.sock.call("perspective.disposeQuery", { uuid: this.uuid, subscriptionId }).catch(() => {});
          this.failures++;
          this.retry = setTimeout(() => { this.retry = null; this.start(); }, reopenDelay(this.failures));
        } else {
          this.retry = setTimeout(() => { this.retry = null; this.start(); }, 50);
        }
      });
  }

  private setLive(v: boolean) {
    if (v === this.live) return;
    this.live = v;
    this.counters.liveSubs += v ? 1 : -1;
  }

  private receive(msg: any) {
    if (msg.type !== "query-subscription-update" || this.disposed) return;
    if (msg.lagged) {
      this.counters.lagged++;
      if (this.id) this.resync();
      return;
    }
    if (!this.id || msg.subscriptionId !== this.id || msg.revision <= this.revision) return;
    if (msg.revision !== this.revision + 1) {
      this.resync();
      return;
    }
    this.revision = msg.revision;
    if (msg.added) this.onRows?.(msg.added);
    else if (msg.result !== undefined) this.onRows?.(msg.result);
    else if (msg.upsert) this.onRows?.(msg.upsert);
  }

  private resync() {
    const id = this.id!;
    this.counters.resyncs++;
    this.sock.call<any>("perspective.resyncSubscription", { uuid: this.uuid, subscriptionId: id }).then(
      (r) => {
        if (this.disposed || this.id !== id) return;
        this.revision = r?.revision ?? this.revision;
        this.onRows?.(r?.result);
      },
      () => {
        if (this.disposed || this.id !== id) return;
        this.sock.call("perspective.disposeQuery", { uuid: this.uuid, subscriptionId: id }).catch(() => {});
        this.id = null;
        this.setLive(false);
        this.start();
      }
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.unlisten();
    this.setLive(false);
    if (this.id) this.sock.call("perspective.disposeQuery", { uuid: this.uuid, subscriptionId: this.id }).catch(() => {});
  }
}

/** Ids of written lines (`…/line/live-<n>`) found anywhere in a result or `added` set. */
export function liveLineIds(rows: unknown): number[] {
  if (rows == null) return [];
  const text = typeof rows === "string" ? rows : JSON.stringify(rows);
  const out: number[] = [];
  const re = /\/line\/live-(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(parseInt(m[1], 10));
  return out;
}

/**
 * Puts the ad4m-devtools bridge into WE's page and collects what it records.
 *
 * Requests come from the bridge — it sees each call's method, params and JS stack. They are taken
 * as the bridge logs them, not read back from its store: that store is a 2,000-entry ring shared
 * with every push event, and a busy executor pushes thousands a minute, so reading it back loses
 * requests. Push events come from Playwright's view of the socket, which also counts every frame
 * so the report can prove the bridge missed nothing. HTTP requests (the SDK sends transcription
 * audio over HTTP) come from Playwright's network events; the bridge does not see `fetch`.
 */

import { createHash } from "crypto";
import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { BrowserContext, Page, Request } from "playwright-core";
import type { CallSiteResolver } from "./callsites.js";
import type { PushEvent, RpcCall, SubscriptionInfo } from "./rpc-analysis.js";

const EXECUTOR_SOCKET = "/api/v1/ws";
/** Names the bridge's frames in stack traces, so its own requests can be told from WE's. */
export const BRIDGE_SOURCE = "ad4m-devtools-bridge.js";

function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

/**
 * The script the devtools extension injects into a page, rebuilt first if its build is missing or
 * older than its source.
 */
export function devtoolsScript(devtoolsRepo: string): string {
  const dist = join(devtoolsRepo, "packages", "extension", "dist", "page-inject.js");
  const sources = Math.max(
    newestMtime(join(devtoolsRepo, "packages", "bridge", "src")),
    newestMtime(join(devtoolsRepo, "packages", "extension", "src")),
  );
  if (!existsSync(dist) || statSync(dist).mtimeMs < sources) {
    console.log(`[u1] Building ad4m-devtools (${existsSync(dist) ? "sources changed" : "no build yet"})...`);
    const env = { ...process.env };
    delete env.NODE_ENV;
    execSync("pnpm install --frozen-lockfile && pnpm build", { cwd: devtoolsRepo, stdio: "pipe", env, timeout: 600000 });
  }
  // Wrapped so the bundle's top-level declarations stay out of the page's global scope.
  return `(() => {\n${readFileSync(dist, "utf8")}\n})();\n//# sourceURL=${BRIDGE_SOURCE}`;
}

/** What ad4m-connect stores after a login, so WE boots straight into the session. */
export function sessionScript(weOrigin: string, connectVersion: string, executorUrl: string, token: string): string {
  const entries = {
    [`${connectVersion}/ad4m-token`]: token,
    [`${connectVersion}/ad4m-url`]: executorUrl,
    [`${connectVersion}/ad4m-port`]: new URL(executorUrl).port,
  };
  return `(() => {
    if (location.origin !== ${JSON.stringify(weOrigin)}) return;
    const entries = ${JSON.stringify(entries)};
    for (const [k, v] of Object.entries(entries)) if (!localStorage.getItem(k)) localStorage.setItem(k, v);
  })();`;
}

/**
 * Wraps the bridge's `logOperation`, `completeOperation` and `patchOperation` — the three calls its
 * WebSocket monitor records through — and keeps a slim copy of every executor request: hashes,
 * sizes, short previews and the stack. `window.__U1_DRAIN__()` hands over what changed since the
 * last drain.
 *
 * The stack kept is the part after `--- async ws.send ---`: V8's own async chain at the moment of
 * sending. The part before it is a caller stack the bridge stashes when an SDK method is entered and
 * pairs with the next send in FIFO order, which under concurrency pairs it with the wrong request.
 *
 * A string rather than a function: tsx compiles functions with helpers that do not exist in the page.
 */
export const TAP_SCRIPT = `(() => {
  if (window.__U1_DRAIN__) return;
  const devtools = window.__AD4M_DEVTOOLS__;
  const docId = Math.random().toString(36).slice(2, 10);
  const SECRET = /pass(word|phrase)?|token|credential|secret|jwt|authorization/i;
  const SEND = '--- async ws.send ---';
  const records = new Map();
  const dirty = new Set();

  const canon = (value, redact) => {
    try {
      const s = JSON.stringify(value, function (key, x) {
        if (redact && key && SECRET.test(key)) return '<redacted>';
        if (x && typeof x === 'object' && ArrayBuffer.isView(x)) return '<' + x.constructor.name + ' ' + x.length + '>';
        if (x && typeof x === 'object' && !Array.isArray(x)) {
          const sorted = {};
          for (const k of Object.keys(x).sort()) sorted[k] = x[k];
          return sorted;
        }
        return x;
      });
      return s === undefined ? '' : s;
    } catch (e) {
      return '<unserializable: ' + (e && e.message) + '>';
    }
  };
  const hash = (s) => {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const sendStack = (stack) => {
    const i = stack.indexOf(SEND);
    return (i < 0 ? stack : stack.slice(i + SEND.length)).split('\\n').filter((l) => l.trim()).slice(0, 60).join('\\n');
  };
  // Whose request: the outermost located frame of the send chain. WE's calls can pass through the
  // bridge's client wrappers, but only the bridge's own calls start in it.
  const originOf = (stack) => {
    const located = stack.split('\\n').filter((l) => /:\\d+:\\d+\\)?\\s*$/.test(l));
    const outermost = located[located.length - 1] || '';
    return outermost.includes(${JSON.stringify(BRIDGE_SOURCE)}) ? 'devtools' : 'app';
  };

  if (devtools) {
    const log = devtools.logOperation;
    const complete = devtools.completeOperation;
    const patch = devtools.patchOperation;

    devtools.logOperation = function (op) {
      const id = log.call(this, op);
      if (op && op.type === 'request' && op.transport === 'websocket' && String(op.url || '').includes(${JSON.stringify(EXECUTOR_SOCKET)})) {
        const body = op.requestBody && typeof op.requestBody === 'object' ? op.requestBody : undefined;
        const params = body ? body.params : undefined;
        const isObj = params && typeof params === 'object' && !Array.isArray(params);
        const stack = sendStack(op.stackTrace || '');
        records.set(id, {
          id,
          method: op.rpcMethod || op.path || op.operationName,
          name: op.operationName,
          start: (devtools.getOperation(id) || {}).startTime || Date.now(),
          requestBytes: op.requestBytes || 0,
          responseBytes: 0,
          responseCount: 0,
          paramsHash: hash(canon(params, false)),
          paramsPreview: cut(canon(params, true), 240),
          paramDigest: isObj ? Object.fromEntries(Object.keys(params).map((k) => [k, hash(canon(params[k], false))])) : undefined,
          stack,
          origin: originOf(stack),
        });
        dirty.add(id);
      }
      return id;
    };

    devtools.completeOperation = function (id, result, errors, options) {
      const out = complete.call(this, id, result, errors, options);
      const rec = records.get(id);
      if (rec) {
        const op = devtools.getOperation(id) || {};
        const response = canon(result, false);
        rec.end = op.endTime;
        rec.duration = op.duration;
        rec.responseBytes = op.totalResponseBytes || op.responseBytes || 0;
        rec.responseCount = op.responseCount || 1;
        rec.responseHash = hash(response);
        rec.responsePreview = cut(response, 160);
        rec.error = errors && errors.length ? String(errors[0].message || errors[0]) : undefined;
        dirty.add(id);
      }
      return out;
    };

    // Subscription pushes are appended to the request that opened the subscription.
    devtools.patchOperation = function (id, fields) {
      const out = patch.call(this, id, fields);
      const rec = records.get(id);
      if (rec && fields && fields.responseCount !== undefined) {
        rec.responseCount = fields.responseCount;
        if (fields.totalResponseBytes !== undefined) rec.responseBytes = fields.totalResponseBytes;
        dirty.add(id);
      }
      return out;
    };
  }

  window.__U1_DRAIN__ = (withSubscriptions) => {
    const ops = [...dirty].map((id) => records.get(id));
    dirty.clear();
    const subscriptions = withSubscriptions && devtools
      ? devtools.getState().subscriptions.map((s) => ({
          id: s.id, query: s.query, perspectiveUUID: s.perspectiveUUID, modelName: s.modelName,
          updateCount: s.updateCount, fingerprintHits: s.fingerprintHits, fingerprintMisses: s.fingerprintMisses, active: s.active,
        }))
      : [];
    return { docId, installed: !!devtools, ops, subscriptions };
  };
})();`;

interface TappedOp {
  id: number;
  method: string;
  name: string;
  start: number;
  end?: number;
  duration?: number;
  requestBytes: number;
  responseBytes: number;
  responseCount: number;
  paramsHash: string;
  paramsPreview: string;
  paramDigest?: Record<string, string>;
  responseHash?: string;
  responsePreview?: string;
  error?: string;
  stack: string;
  origin: "app" | "devtools";
}

interface Drain {
  docId: string;
  installed: boolean;
  ops: TappedOp[];
  subscriptions: (SubscriptionInfo & { id: number })[];
}

interface HttpCall {
  method: string;
  start: number;
  durationMs?: number;
  requestBytes: number;
  responseBytes: number;
  bodyHash: string;
  preview: string;
  error?: string;
}

export interface TranscriptLine {
  at: number;
  text: string;
  streamId?: string;
}

export interface CaptureIntegrity {
  devtoolsInstalled: boolean;
  /** Every executor request the bridge logged, WE's and its own. */
  tappedRequests: number;
  /** Requests the devtools bridge made itself, excluded from the analysis. */
  devtoolsOwnRequests: number;
  /** RPC requests Playwright saw leave on the executor socket — equal to `tappedRequests` when nothing was missed. */
  wireRequests: number;
  wireResponses: number;
  wireEvents: number;
  wireSentBytes: number;
  wireReceivedBytes: number;
  /** Executor WebSockets the page opened. */
  sockets: number;
  httpRequests: number;
}

export class RpcCollector {
  private ops = new Map<string, TappedOp>();
  private subs = new Map<string, SubscriptionInfo>();
  private events: PushEvent[] = [];
  private lines: TranscriptLine[] = [];
  private http: HttpCall[] = [];
  private pendingHttp = new Set<Promise<void>>();
  private wire = { requests: 0, responses: 0, events: 0, sentBytes: 0, receivedBytes: 0 };
  private installed = false;
  private sockets = 0;
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;

  constructor(
    private page: Page,
    private executorOrigin: string,
  ) {}

  attach(context: BrowserContext): void {
    const onRequest = (req: Request, failed: boolean) => {
      if (!req.url().startsWith(this.executorOrigin)) return;
      const p = this.recordHttp(req, failed).finally(() => this.pendingHttp.delete(p));
      this.pendingHttp.add(p);
    };
    context.on("requestfinished", (req) => onRequest(req, false));
    context.on("requestfailed", (req) => onRequest(req, true));

    this.page.on("websocket", (ws) => {
      if (!ws.url().includes(EXECUTOR_SOCKET)) return;
      const socket = ++this.sockets;
      ws.on("framesent", ({ payload }) => {
        const text = payload.toString();
        this.wire.sentBytes += Buffer.byteLength(text);
        const msg = parse(text);
        if (msg && msg.id != null && msg.type) this.wire.requests++;
      });
      ws.on("framereceived", ({ payload }) => {
        const text = payload.toString();
        const bytes = Buffer.byteLength(text);
        this.wire.receivedBytes += bytes;
        const msg = parse(text);
        if (msg && msg.id != null) {
          this.wire.responses++;
        } else if (msg && msg.type) {
          this.wire.events++;
          const at = Date.now();
          const hash = createHash("sha1").update(text).digest("base64url").slice(0, 16);
          this.events.push({ type: String(msg.type), at, bytes, hash, socket });
          if (msg.type === "transcription-text" && typeof msg.text === "string" && msg.text.trim()) {
            this.lines.push({ at, text: msg.text.trim(), streamId: msg.streamId });
          }
        }
      });
    });
  }

  start(intervalMs = 1000): void {
    this.timer = setInterval(() => {
      if (!this.draining) this.draining = this.drain(false).finally(() => (this.draining = undefined));
    }, intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.draining;
    await this.drain(true);
    await Promise.all(this.pendingHttp);
  }

  private async drain(withSubscriptions: boolean): Promise<void> {
    const result = (await this.page
      .evaluate(`window.__U1_DRAIN__ ? window.__U1_DRAIN__(${withSubscriptions}) : null`)
      .catch(() => null)) as Drain | null;
    if (!result) return;
    this.installed ||= result.installed;
    for (const op of result.ops) this.ops.set(`${result.docId}:${op.id}`, op);
    for (const s of result.subscriptions) this.subs.set(`${result.docId}:${s.id}`, s);
  }

  /** Transcribed text as it arrived on the socket, in order. */
  transcript(): TranscriptLine[] {
    return [...this.lines];
  }

  async snapshot(sites: CallSiteResolver): Promise<{
    calls: RpcCall[];
    events: PushEvent[];
    subscriptions: SubscriptionInfo[];
    integrity: CaptureIntegrity;
  }> {
    const calls: RpcCall[] = [];
    let devtoolsOwn = 0;
    for (const [key, op] of this.ops) {
      if (op.origin === "devtools") {
        devtoolsOwn++;
        continue;
      }
      calls.push({
        key,
        channel: "ws",
        method: op.method,
        label: op.name,
        start: op.start,
        end: op.end,
        durationMs: op.duration,
        requestBytes: op.requestBytes,
        responseBytes: op.responseBytes,
        paramsHash: op.paramsHash,
        paramsPreview: op.paramsPreview,
        paramDigest: op.paramDigest,
        responseHash: op.responseHash,
        responsePreview: op.responsePreview,
        error: op.error,
        callSite: await sites.resolve(op.stack),
        updates: Math.max(0, op.responseCount - 1),
      });
    }
    this.http.forEach((h, i) =>
      calls.push({
        key: `http:${i}`,
        channel: "http",
        method: h.method,
        start: h.start,
        end: h.durationMs === undefined ? undefined : h.start + h.durationMs,
        durationMs: h.durationMs,
        requestBytes: h.requestBytes,
        responseBytes: h.responseBytes,
        paramsHash: h.bodyHash,
        paramsPreview: h.preview,
        error: h.error,
      }),
    );
    calls.sort((a, b) => a.start - b.start);
    return {
      calls,
      events: [...this.events],
      subscriptions: [...this.subs.values()],
      integrity: {
        devtoolsInstalled: this.installed,
        tappedRequests: this.ops.size,
        devtoolsOwnRequests: devtoolsOwn,
        wireRequests: this.wire.requests,
        wireResponses: this.wire.responses,
        wireEvents: this.wire.events,
        wireSentBytes: this.wire.sentBytes,
        wireReceivedBytes: this.wire.receivedBytes,
        sockets: this.sockets,
        httpRequests: this.http.length,
      },
    };
  }

  private async recordHttp(req: Request, failed: boolean): Promise<void> {
    const timing = req.timing();
    const sizes = failed ? null : await req.sizes().catch(() => null);
    const response = failed ? null : await req.response().catch(() => null);
    const body = req.postDataBuffer();
    const streams = req.headers()["x-stream-ids"];
    this.http.push({
      method: `${req.method()} ${new URL(req.url()).pathname}`,
      start: timing.startTime,
      durationMs: timing.responseEnd >= 0 ? timing.responseEnd : undefined,
      requestBytes: sizes?.requestBodySize ?? body?.length ?? 0,
      responseBytes: sizes?.responseBodySize ?? 0,
      bodyHash: body ? createHash("sha1").update(body).digest("hex").slice(0, 12) : "",
      preview: `${body ? `${body.length} bytes` : "no body"}${streams ? ` → streams ${streams}` : ""}`,
      error: failed ? (req.failure()?.errorText ?? "failed") : response && !response.ok() ? `HTTP ${response.status()}` : undefined,
    });
  }
}

function parse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

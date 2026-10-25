/**
 * W1 helper: aggregate the recorder's raw frames/calls per phase and render the markdown summary.
 */

import type { FrameRecord, HttpRecord, RpcCall, SocketRecord } from "./ws-recorder.js";

export interface MethodRow {
  method: string;
  count: number;
  errors: number;
  unanswered: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  paramsBytes: number;
  responseBytes: number;
}

export interface DuplicateRow {
  method: string;
  callHash: string;
  count: number;
  responseBytes: number;
  totalMs: number;
  paramsPreview: string;
}

export interface EventRow {
  event: string;
  count: number;
  bytes: number;
}

export interface PhaseAggregate {
  phase: string;
  durationMs: number;
  calls: number;
  callsPerSec: number;
  /** Calls whose (method, params) was already sent earlier in the same phase. */
  duplicateCalls: number;
  distinctCalls: number;
  errors: number;
  unanswered: number;
  framesSent: number;
  framesRecv: number;
  bytesSent: number;
  bytesRecv: number;
  events: number;
  pings: number;
  http: number;
  methods: MethodRow[];
  duplicates: DuplicateRow[];
  eventTypes: EventRow[];
  /** Calls sent per 1 s bucket from the phase start. */
  callsPerSecond: number[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function aggregatePhase(
  phase: string,
  window: { startMs: number; endMs: number },
  calls: RpcCall[],
  frames: FrameRecord[],
  http: HttpRecord[],
  topDuplicates = 30,
): PhaseAggregate {
  const pc = calls.filter((c) => c.phase === phase);
  const pf = frames.filter((f) => f.phase === phase);
  const durationMs = Math.max(1, window.endMs - window.startMs);

  const byMethod = new Map<string, RpcCall[]>();
  for (const c of pc) {
    const list = byMethod.get(c.method) ?? [];
    list.push(c);
    byMethod.set(c.method, list);
  }
  const methods: MethodRow[] = [...byMethod.entries()].map(([method, list]) => {
    const lat = list.filter((c) => c.latencyMs !== undefined).map((c) => c.latencyMs!).sort((a, b) => a - b);
    const total = lat.reduce((a, b) => a + b, 0);
    return {
      method,
      count: list.length,
      errors: list.filter((c) => c.error).length,
      unanswered: list.filter((c) => c.latencyMs === undefined).length,
      totalMs: round(total),
      avgMs: round(lat.length ? total / lat.length : 0),
      p50Ms: round(percentile(lat, 0.5)),
      p95Ms: round(percentile(lat, 0.95)),
      maxMs: round(lat.length ? lat[lat.length - 1] : 0),
      paramsBytes: list.reduce((a, c) => a + c.paramsBytes, 0),
      responseBytes: list.reduce((a, c) => a + (c.responseBytes ?? 0), 0),
    };
  });
  methods.sort((a, b) => b.count - a.count || b.totalMs - a.totalMs);

  const byHash = new Map<string, RpcCall[]>();
  for (const c of pc) {
    const list = byHash.get(c.callHash) ?? [];
    list.push(c);
    byHash.set(c.callHash, list);
  }
  const duplicates: DuplicateRow[] = [...byHash.values()]
    .filter((list) => list.length > 1)
    .map((list) => ({
      method: list[0].method,
      callHash: list[0].callHash,
      count: list.length,
      responseBytes: list.reduce((a, c) => a + (c.responseBytes ?? 0), 0),
      totalMs: round(list.reduce((a, c) => a + (c.latencyMs ?? 0), 0)),
      paramsPreview: list[0].paramsPreview,
    }))
    .sort((a, b) => b.count - a.count || b.totalMs - a.totalMs);
  const duplicateCalls = duplicates.reduce((a, d) => a + d.count - 1, 0);

  const byEvent = new Map<string, EventRow>();
  for (const f of pf) {
    if (f.kind !== "event") continue;
    const row = byEvent.get(f.event!) ?? { event: f.event!, count: 0, bytes: 0 };
    row.count++;
    row.bytes += f.bytes;
    byEvent.set(f.event!, row);
  }
  const eventTypes = [...byEvent.values()].sort((a, b) => b.count - a.count);

  const buckets = Math.ceil(durationMs / 1000);
  const callsPerSecond = new Array(Math.min(buckets, 3600)).fill(0);
  for (const c of pc) {
    const b = Math.floor((c.sentAt - window.startMs) / 1000);
    if (b >= 0 && b < callsPerSecond.length) callsPerSecond[b]++;
  }

  return {
    phase,
    durationMs: Math.round(durationMs),
    calls: pc.length,
    callsPerSec: round((pc.length * 1000) / durationMs, 2),
    duplicateCalls,
    distinctCalls: byHash.size,
    errors: pc.filter((c) => c.error).length,
    unanswered: pc.filter((c) => c.latencyMs === undefined).length,
    framesSent: pf.filter((f) => f.dir === "sent").length,
    framesRecv: pf.filter((f) => f.dir === "recv").length,
    bytesSent: pf.filter((f) => f.dir === "sent").reduce((a, f) => a + f.bytes, 0),
    bytesRecv: pf.filter((f) => f.dir === "recv").reduce((a, f) => a + f.bytes, 0),
    events: pf.filter((f) => f.kind === "event").length,
    pings: pf.filter((f) => f.kind === "ping").length,
    http: http.filter((h) => h.phase === phase).length,
    methods,
    duplicates: duplicates.slice(0, topDuplicates),
    eventTypes,
    callsPerSecond,
  };
}

/** Sockets to the executor: how many opened, and how many were re-opened after an earlier one closed. */
export function socketSummary(sockets: SocketRecord[]) {
  const exec = sockets.filter((s) => s.executor).sort((a, b) => a.createdAt - b.createdAt);
  let reconnects = 0;
  for (let i = 1; i < exec.length; i++) {
    if (exec.slice(0, i).some((prev) => prev.closedAt !== undefined)) reconnects++;
  }
  return {
    executorSockets: exec.length,
    otherSockets: sockets.length - exec.length,
    reconnects,
    sockets: exec.map((s) => ({
      url: s.safeUrl,
      openedInPhase: s.phase,
      closed: s.closedAt !== undefined,
      framesSent: s.framesSent,
      framesRecv: s.framesRecv,
      bytesSent: s.bytesSent,
      bytesRecv: s.bytesRecv,
    })),
  };
}

// ─── markdown ─────────────────────────────────────────────────────────────────

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`);
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function phaseMarkdown(title: string, a: PhaseAggregate, opts: { methods?: number; duplicates?: number } = {}): string {
  const lines: string[] = [];
  lines.push(`### ${title}`);
  lines.push("");
  lines.push(
    `${a.calls} RPC calls in ${(a.durationMs / 1000).toFixed(1)} s (${a.callsPerSec}/s) · ${a.distinctCalls} distinct · ` +
      `**${a.duplicateCalls} repeats of an identical call** · ${a.errors} errors · ${a.unanswered} unanswered · ` +
      `${a.events} events · ${a.pings} pings · sent ${a.framesSent} frames / ${kb(a.bytesSent)} · ` +
      `received ${a.framesRecv} frames / ${kb(a.bytesRecv)} · HTTP ${a.http}`,
  );
  lines.push("");
  if (a.methods.length) {
    lines.push("| Method | Count | Total ms | Avg ms | p95 ms | Max ms | Params | Response | Err |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const m of a.methods.slice(0, opts.methods ?? 40)) {
      lines.push(
        `| \`${m.method}\` | ${m.count} | ${m.totalMs} | ${m.avgMs} | ${m.p95Ms} | ${m.maxMs} | ${kb(m.paramsBytes)} | ${kb(m.responseBytes)} | ${m.errors}${m.unanswered ? ` (+${m.unanswered} open)` : ""} |`,
      );
    }
    lines.push("");
  }
  if (a.duplicates.length && (opts.duplicates ?? 15) > 0) {
    lines.push("Top repeated identical calls (same method + same params):");
    lines.push("");
    lines.push("| × | Method | Total ms | Response | Params (start) |");
    lines.push("|---:|---|---:|---:|---|");
    for (const d of a.duplicates.slice(0, opts.duplicates ?? 15)) {
      lines.push(`| ${d.count} | \`${d.method}\` | ${d.totalMs} | ${kb(d.responseBytes)} | \`${esc(d.paramsPreview.slice(0, 160))}\` |`);
    }
    lines.push("");
  }
  if (a.eventTypes.length) {
    lines.push("Events received: " + a.eventTypes.map((e) => `\`${e.event}\` ${e.count} (${kb(e.bytes)})`).join(", "));
    lines.push("");
  }
  return lines.join("\n");
}

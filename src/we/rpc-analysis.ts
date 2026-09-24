/**
 * Turns the traffic WE sent the executor into findings about redundant and expensive calls.
 * Pure — the scenario collects, this decides — so every rule here is unit-tested.
 */

export type Channel = "ws" | "http";
export type CallKind = "read" | "write" | "subscribe";

export interface RpcCall {
  key: string;
  channel: Channel;
  method: string;
  /** The devtools' human label, e.g. `TextBlock.query (where, limit=50)`. */
  label?: string;
  start: number;
  end?: number;
  durationMs?: number;
  requestBytes: number;
  responseBytes: number;
  paramsHash: string;
  paramsPreview: string;
  /** Top-level param key → hash of its value, so a burst can say which keys varied. */
  paramDigest?: Record<string, string>;
  responseHash?: string;
  responsePreview?: string;
  error?: string;
  callSite?: string;
  /** Subscription pushes routed to this call after its first answer; `responseBytes` includes them. */
  updates?: number;
}

export interface PushEvent {
  type: string;
  at: number;
  bytes: number;
  /** Hash of the whole frame: equal hashes are the same message delivered again. */
  hash?: string;
  /** Which executor socket it arrived on, numbered in the order the page opened them. */
  socket?: number;
}

export interface Phase {
  name: string;
  start: number;
  end: number;
}

export interface SubscriptionInfo {
  query: string;
  perspectiveUUID: string;
  modelName: string;
  updateCount: number;
  fingerprintHits: number;
  fingerprintMisses: number;
  active: boolean;
}

export interface MethodStats {
  method: string;
  kind: CallKind;
  calls: number;
  errors: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  requestBytes: number;
  responseBytes: number;
}

export interface DuplicateGroup {
  method: string;
  kind: CallKind;
  paramsHash: string;
  paramsPreview: string;
  calls: number;
  /** Later reads whose answer was identical to the one before — a cache would have served them. */
  unchangedRepeats: number;
  /** Calls started while an identical call was still in flight — sharing the promise would have saved them. */
  concurrentRepeats: number;
  wastedMs: number;
  wastedBytes: number;
  firstAt: number;
  lastAt: number;
  minIntervalMs: number;
  /** Different answers the executor gave to the identical calls. */
  distinctAnswers: number;
  medianIntervalMs?: number;
  intervalCv?: number;
  callSites: string[];
  phases: string[];
}

export interface PollingLoop {
  method: string;
  paramsPreview: string;
  calls: number;
  periodMs: number;
  unchangedRatio: number;
  callSites: string[];
}

export interface FanOutBurst {
  method: string;
  calls: number;
  distinctParams: number;
  windowMs: number;
  totalMs: number;
  varyingKeys: string[];
  samples: string[];
  callSites: string[];
  phase: string;
}

export interface ErrorGroup {
  method: string;
  message: string;
  calls: number;
  callSites: string[];
  phases: string[];
}

export interface SubscriptionFindings {
  total: number;
  activeAtEnd: number;
  updates: number;
  unchangedUpdates: number;
  duplicateActive: { modelName: string; perspectiveUUID: string; query: string; active: number }[];
}

export interface EventStats {
  type: string;
  count: number;
  bytes: number;
  perSecond: number;
  /** Copies of a message already received within `THRESHOLDS.duplicateEventWindowMs`. */
  duplicates: number;
  duplicateBytes: number;
  /** Of those, copies that arrived on a different socket from the first — a second subscriber, not a second send. */
  crossSocketDuplicates: number;
}

export interface PhaseStats {
  name: string;
  wallMs: number;
  calls: number;
  methods: number;
  sumMs: number;
  requestBytes: number;
  responseBytes: number;
  events: number;
  eventBytes: number;
}

export interface Analysis {
  totals: {
    calls: number;
    wsCalls: number;
    httpCalls: number;
    errors: number;
    requestBytes: number;
    responseBytes: number;
    events: number;
    eventBytes: number;
    duplicateEvents: number;
    redundantReads: number;
    coalescable: number;
    identicalWrites: number;
  };
  phases: PhaseStats[];
  methods: MethodStats[];
  duplicates: DuplicateGroup[];
  polling: PollingLoop[];
  identicalWrites: DuplicateGroup[];
  fanOut: FanOutBurst[];
  errors: ErrorGroup[];
  slowest: RpcCall[];
  largest: RpcCall[];
  subscriptions: SubscriptionFindings;
  events: EventStats[];
}

export const THRESHOLDS = {
  /** Calls of one method this close together count as one burst. */
  burstGapMs: 150,
  burstMinCalls: 5,
  burstMinDistinct: 3,
  /** A repeat this regular and this slow is a loop somebody wrote, not a coincidence. */
  pollingMinCalls: 4,
  pollingMaxCv: 0.35,
  pollingMinPeriodMs: 1000,
  /** Identical writes further apart than this are periodic, and reported as polling instead. */
  identicalWriteWindowMs: 5000,
  /** The same push message twice within this window is one delivery too many. */
  duplicateEventWindowMs: 1000,
  topN: 15,
};

/** A call writes if any word of its camelCase method name is one of these — the wire carries no read/write flag. */
const WRITE_WORDS = new Set(
  "add create update remove delete set publish join send open close feed execute commit generate lock unlock dispose register install accept reject apply import mint propose transition login signup leave start stop keep".split(" "),
);

export function callKind(method: string): CallKind {
  if (/subscribe|listener|callback/i.test(method)) return "subscribe";
  if (/^(POST|PUT|PATCH|DELETE) /.test(method)) return "write";
  const words = method.split(/[\s./]+|(?=[A-Z])/).map((w) => w.toLowerCase());
  return words.some((w) => WRITE_WORDS.has(w)) ? "write" : "read";
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** The phase running at `t`; between two phases, the one that just ended. */
export function phaseOf(t: number, phases: Phase[]): string {
  if (phases.length === 0) return "run";
  let current = phases[0].name;
  for (const p of phases) if (p.start <= t) current = p.name;
  return current;
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const group = out.get(k);
    if (group) group.push(x);
    else out.set(k, [x]);
  }
  return out;
}
const sites = (calls: RpcCall[]) => unique(calls.map((c) => c.callSite).filter((s): s is string => !!s));
const bytesOf = (c: RpcCall) => c.requestBytes + c.responseBytes;

function intervalsOf(calls: RpcCall[]): { median?: number; cv?: number } {
  if (calls.length < 3) return {};
  const gaps = calls.slice(1).map((c, i) => c.start - calls[i].start);
  const sorted = [...gaps].sort((a, b) => a - b);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean <= 0) return { median: 0 };
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  return { median: percentile(sorted, 50), cv: sd / mean };
}

export function methodStats(calls: RpcCall[]): MethodStats[] {
  return [...groupBy(calls, (c) => c.method).entries()]
    .map(([method, cs]) => {
      const ms = cs.map((c) => c.durationMs ?? 0).sort((a, b) => a - b);
      return {
        method,
        kind: callKind(method),
        calls: cs.length,
        errors: cs.filter((c) => c.error).length,
        totalMs: ms.reduce((a, b) => a + b, 0),
        p50Ms: percentile(ms, 50),
        p95Ms: percentile(ms, 95),
        maxMs: ms[ms.length - 1] ?? 0,
        requestBytes: cs.reduce((a, c) => a + c.requestBytes, 0),
        responseBytes: cs.reduce((a, c) => a + c.responseBytes, 0),
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls);
}

export function duplicateGroups(calls: RpcCall[], phases: Phase[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  for (const cs of groupBy(calls, (c) => `${c.method}\u0000${c.paramsHash}`).values()) {
    if (cs.length < 2) continue;
    cs.sort((a, b) => a.start - b.start);
    const kind = callKind(cs[0].method);
    let unchanged = 0;
    let concurrent = 0;
    let wastedMs = 0;
    let wastedBytes = 0;
    let minInterval = Infinity;
    let inFlightUntil = cs[0].end ?? cs[0].start;
    for (let i = 1; i < cs.length; i++) {
      const prev = cs[i - 1];
      const cur = cs[i];
      minInterval = Math.min(minInterval, cur.start - prev.start);
      if (cur.start < inFlightUntil) concurrent++;
      inFlightUntil = Math.max(inFlightUntil, cur.end ?? cur.start);
      const same = !cur.error && !prev.error && !!cur.responseHash && cur.responseHash === prev.responseHash;
      if (kind === "read" && same) {
        unchanged++;
        wastedMs += cur.durationMs ?? 0;
        wastedBytes += cur.responseBytes;
      }
    }
    const { median, cv } = intervalsOf(cs);
    groups.push({
      method: cs[0].method,
      kind,
      paramsHash: cs[0].paramsHash,
      paramsPreview: cs[0].paramsPreview,
      calls: cs.length,
      unchangedRepeats: unchanged,
      concurrentRepeats: concurrent,
      wastedMs,
      wastedBytes,
      firstAt: cs[0].start,
      lastAt: cs[cs.length - 1].start,
      minIntervalMs: minInterval,
      distinctAnswers: unique(cs.map((c) => c.responseHash).filter((h) => h !== undefined)).length,
      medianIntervalMs: median,
      intervalCv: cv,
      callSites: sites(cs),
      phases: unique(cs.map((c) => phaseOf(c.start, phases))),
    });
  }
  return groups.sort(
    (a, b) =>
      b.unchangedRepeats + b.concurrentRepeats - (a.unchangedRepeats + a.concurrentRepeats) ||
      b.wastedMs - a.wastedMs ||
      b.calls - a.calls,
  );
}

export function isPolling(g: DuplicateGroup): boolean {
  return (
    g.calls >= THRESHOLDS.pollingMinCalls &&
    g.intervalCv !== undefined &&
    g.intervalCv <= THRESHOLDS.pollingMaxCv &&
    (g.medianIntervalMs ?? 0) >= THRESHOLDS.pollingMinPeriodMs
  );
}

export function pollingLoops(groups: DuplicateGroup[]): PollingLoop[] {
  return groups
    .filter(isPolling)
    .map((g) => ({
      method: g.method,
      paramsPreview: g.paramsPreview,
      calls: g.calls,
      periodMs: g.medianIntervalMs ?? 0,
      unchangedRatio: g.kind === "read" ? g.unchangedRepeats / (g.calls - 1) : 0,
      callSites: g.callSites,
    }))
    .sort((a, b) => b.calls - a.calls);
}

/** Identical writes close together — a double submit, not a heartbeat. */
export function identicalWrites(groups: DuplicateGroup[]): DuplicateGroup[] {
  return groups.filter(
    (g) => g.kind === "write" && !isPolling(g) && g.minIntervalMs <= THRESHOLDS.identicalWriteWindowMs,
  );
}

export function fanOutBursts(calls: RpcCall[], phases: Phase[]): FanOutBurst[] {
  const bursts: FanOutBurst[] = [];
  for (const [method, cs] of groupBy(calls, (c) => c.method)) {
    cs.sort((a, b) => a.start - b.start);
    let run: RpcCall[] = [];
    const flush = () => {
      const distinct = unique(run.map((c) => c.paramsHash));
      if (run.length >= THRESHOLDS.burstMinCalls && distinct.length >= THRESHOLDS.burstMinDistinct) {
        const keys = unique(run.flatMap((c) => Object.keys(c.paramDigest ?? {})));
        bursts.push({
          method,
          calls: run.length,
          distinctParams: distinct.length,
          windowMs: run[run.length - 1].start - run[0].start,
          totalMs: run.reduce((a, c) => a + (c.durationMs ?? 0), 0),
          varyingKeys: keys.filter((k) => unique(run.map((c) => c.paramDigest?.[k] ?? "")).length > 1),
          samples: unique(run.map((c) => c.paramsPreview)).slice(0, 3),
          callSites: sites(run),
          phase: phaseOf(run[0].start, phases),
        });
      }
      run = [];
    };
    for (const c of cs) {
      if (run.length && c.start - run[run.length - 1].start > THRESHOLDS.burstGapMs) flush();
      run.push(c);
    }
    flush();
  }
  return bursts.sort((a, b) => b.calls - a.calls);
}

export function errorGroups(calls: RpcCall[], phases: Phase[]): ErrorGroup[] {
  const failed = calls.filter((c) => c.error);
  return [...groupBy(failed, (c) => `${c.method}\u0000${c.error}`).values()]
    .map((cs) => ({
      method: cs[0].method,
      message: cs[0].error!,
      calls: cs.length,
      callSites: sites(cs),
      phases: unique(cs.map((c) => phaseOf(c.start, phases))),
    }))
    .sort((a, b) => b.calls - a.calls);
}

export function subscriptionFindings(subs: SubscriptionInfo[]): SubscriptionFindings {
  const active = subs.filter((s) => s.active);
  const by = groupBy(active, (s) => `${s.perspectiveUUID}\u0000${s.modelName}\u0000${s.query}`);
  return {
    total: subs.length,
    activeAtEnd: active.length,
    updates: subs.reduce((a, s) => a + s.updateCount, 0),
    unchangedUpdates: subs.reduce((a, s) => a + s.fingerprintHits, 0),
    duplicateActive: [...by.values()]
      .filter((ss) => ss.length > 1)
      .map((ss) => ({
        modelName: ss[0].modelName,
        perspectiveUUID: ss[0].perspectiveUUID,
        query: ss[0].query,
        active: ss.length,
      }))
      .sort((a, b) => b.active - a.active),
  };
}

/** Events that repeat a message received moments before, and whether the copy came on another socket. */
export function duplicateEventsOf(events: PushEvent[]): Map<PushEvent, "same-socket" | "cross-socket"> {
  const lastSeen = new Map<string, PushEvent>();
  const dupes = new Map<PushEvent, "same-socket" | "cross-socket">();
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (!e.hash) continue;
    const prev = lastSeen.get(e.hash);
    if (prev && e.at - prev.at <= THRESHOLDS.duplicateEventWindowMs) {
      dupes.set(e, prev.socket === e.socket ? "same-socket" : "cross-socket");
    }
    lastSeen.set(e.hash, e);
  }
  return dupes;
}

export function eventStats(events: PushEvent[], wallMs: number): EventStats[] {
  const dupes = duplicateEventsOf(events);
  const seconds = Math.max(wallMs / 1000, 1);
  return [...groupBy(events, (e) => e.type).entries()]
    .map(([type, es]) => {
      const repeated = es.filter((e) => dupes.has(e));
      return {
        type,
        count: es.length,
        bytes: es.reduce((a, e) => a + e.bytes, 0),
        perSecond: es.length / seconds,
        duplicates: repeated.length,
        duplicateBytes: repeated.reduce((a, e) => a + e.bytes, 0),
        crossSocketDuplicates: repeated.filter((e) => dupes.get(e) === "cross-socket").length,
      };
    })
    .sort((a, b) => b.count - a.count);
}

export function phaseStats(calls: RpcCall[], events: PushEvent[], phases: Phase[]): PhaseStats[] {
  return phases.map((p) => {
    const cs = calls.filter((c) => phaseOf(c.start, phases) === p.name);
    const es = events.filter((e) => phaseOf(e.at, phases) === p.name);
    return {
      name: p.name,
      wallMs: p.end - p.start,
      calls: cs.length,
      methods: unique(cs.map((c) => c.method)).length,
      sumMs: cs.reduce((a, c) => a + (c.durationMs ?? 0), 0),
      requestBytes: cs.reduce((a, c) => a + c.requestBytes, 0),
      responseBytes: cs.reduce((a, c) => a + c.responseBytes, 0),
      events: es.length,
      eventBytes: es.reduce((a, e) => a + e.bytes, 0),
    };
  });
}

export function analyse(input: {
  calls: RpcCall[];
  events: PushEvent[];
  phases: Phase[];
  subscriptions: SubscriptionInfo[];
}): Analysis {
  const { calls, events, phases, subscriptions } = input;
  const duplicates = duplicateGroups(calls, phases);
  const writes = identicalWrites(duplicates);
  const wallMs = phases.length ? phases[phases.length - 1].end - phases[0].start : 0;
  const eventTypes = eventStats(events, wallMs);
  return {
    totals: {
      calls: calls.length,
      wsCalls: calls.filter((c) => c.channel === "ws").length,
      httpCalls: calls.filter((c) => c.channel === "http").length,
      errors: calls.filter((c) => c.error).length,
      requestBytes: calls.reduce((a, c) => a + c.requestBytes, 0),
      responseBytes: calls.reduce((a, c) => a + c.responseBytes, 0),
      events: events.length,
      eventBytes: events.reduce((a, e) => a + e.bytes, 0),
      duplicateEvents: eventTypes.reduce((a, t) => a + t.duplicates, 0),
      redundantReads: duplicates.reduce((a, g) => a + g.unchangedRepeats, 0),
      coalescable: duplicates.reduce((a, g) => a + g.concurrentRepeats, 0),
      identicalWrites: writes.reduce((a, g) => a + g.calls - 1, 0),
    },
    phases: phaseStats(calls, events, phases),
    methods: methodStats(calls),
    duplicates,
    polling: pollingLoops(duplicates),
    identicalWrites: writes,
    fanOut: fanOutBursts(calls, phases),
    errors: errorGroups(calls, phases),
    slowest: [...calls].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, THRESHOLDS.topN),
    largest: [...calls].sort((a, b) => bytesOf(b) - bytesOf(a)).slice(0, THRESHOLDS.topN),
    subscriptions: subscriptionFindings(subscriptions),
    events: eventTypes,
  };
}

/** Share of the expected words that appear in the transcript — order-insensitive, punctuation-blind. */
export function wordCoverage(expected: string, actual: string): number {
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const want = words(expected);
  if (want.length === 0) return 1;
  const have = new Set(words(actual));
  return want.filter((w) => have.has(w)).length / want.length;
}

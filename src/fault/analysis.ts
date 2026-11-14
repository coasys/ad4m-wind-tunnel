/**
 * Pure analysis for the fault-injection scenarios (f1): turn per-second
 * samples into "did work pile up during the fault" and "how long until the
 * executor was back to its pre-fault state". No I/O here, so it is unit tested
 * (src/fault/fault.test.ts).
 */

export type Phase = "baseline" | "fault" | "recovery";

/** One sample per second of the run. */
export interface FaultSample {
  /** ms since the level started */
  tMs: number;
  phase: Phase;
  /** Executor CPU over the last interval, % of one core (executor + children). */
  cpuPercent: number;
  rssKb: number;
  threads: number;
  /** Threads named `ad4m-eval-watchdog` (kernel comm `ad4m-eval-watch`): one per running SPARQL evaluation. */
  evalThreads: number;
  /** Subscriptions registered on the executor: `created` log lines minus `dropped` counts (an upper bound). */
  executorSubs: number;
  /** Live queries the clients hold (subscribe answered, not disposed). */
  clientLiveSubs: number;
  /** Client calls sent and not yet answered or timed out. */
  clientInflight: number;
  /** Cumulative client timeouts. */
  timeouts: number;
  /** Cumulative re-subscribes (a new subscribe after a failed or timed-out one). */
  resubscribes: number;
  /** Cumulative cgroup throttled time, ms (cpu.stat throttled_usec). */
  throttledMs: number;
  /**
   * Cumulative `request.cancel`s the clients sent for timed-out subscribes.
   * The executor registers a subscription before its first result and takes
   * it out again, without a log line, when the call is cancelled
   * (subscriptions.rs `UnregisterOnDrop`), so each cancel may hide one
   * `created` line that has no `dropped` line.
   */
  subCancels?: number;
}

/**
 * Subscriptions the executor holds that no client holds: created − dropped −
 * cancelled subscribes − client live queries, floored at 0. Without the
 * cancel correction a slow executor looks like it leaks one subscription per
 * cancelled subscribe.
 */
export function orphanSubs(s: FaultSample): number {
  return Math.max(0, s.executorSubs - (s.subCancels ?? 0) - s.clientLiveSubs);
}

export function percentile(values: number[], p: number): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1));
  return v[idx];
}

/** Least-squares slope of y over x (per unit of x); 0 for fewer than two points. */
export function slope(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
  }
  const d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}

/**
 * Outstanding work at one instant: evaluations running, calls waiting for an
 * answer, and subscriptions the executor holds beyond the ones the clients
 * hold (orphans: they re-run on every write for nobody).
 */
export function backlog(s: FaultSample): number {
  return s.evalThreads + s.clientInflight + orphanSubs(s);
}

export interface PileupVerdict {
  /** Work kept growing to the end of the fault window. */
  pileup: boolean;
  /** Backlog at the end of the baseline / peak in the fault / end of the fault. */
  baselineBacklog: number;
  peakBacklog: number;
  endFaultBacklog: number;
  /** Backlog growth per minute over the second half of the fault window. */
  growthPerMin: number;
  reason: string;
}

/**
 * Pileup = in the second half of the fault window the backlog still grows
 * (least-squares slope above `minGrowthPerMin` per minute) and its end value
 * is well above baseline (more than `factor`× the baseline p95, plus
 * `minAbsolute`). A backlog that rises once and then holds flat is
 * saturation, not a pileup: the queue is bounded.
 */
export function classifyPileup(
  samples: FaultSample[],
  opts: { factor?: number; minAbsolute?: number; minGrowthPerMin?: number } = {}
): PileupVerdict {
  const factor = opts.factor ?? 2;
  const minAbsolute = opts.minAbsolute ?? 4;
  const minGrowthPerMin = opts.minGrowthPerMin ?? 2;
  const base = samples.filter((s) => s.phase === "baseline").map(backlog);
  const fault = samples.filter((s) => s.phase === "fault");
  const baselineBacklog = base.length ? percentile(base, 0.95) : 0;
  if (fault.length === 0) {
    return { pileup: false, baselineBacklog, peakBacklog: NaN, endFaultBacklog: NaN, growthPerMin: 0, reason: "no fault samples" };
  }
  const fb = fault.map(backlog);
  const peakBacklog = Math.max(...fb);
  // The end value: mean of the last 10% (at least one sample) to damp noise.
  const tail = fb.slice(-Math.max(1, Math.floor(fb.length / 10)));
  const endFaultBacklog = tail.reduce((a, b) => a + b, 0) / tail.length;
  const half = fault.slice(Math.floor(fault.length / 2));
  const growthPerMin = slope(half.map((s) => s.tMs / 60000), half.map(backlog));
  const high = endFaultBacklog > factor * baselineBacklog + minAbsolute;
  const growing = growthPerMin > minGrowthPerMin;
  const pileup = high && growing;
  const reason = pileup
    ? `backlog still growing at ${growthPerMin.toFixed(1)}/min at the end of the fault, ${endFaultBacklog.toFixed(0)} vs baseline ${baselineBacklog}`
    : high
      ? `backlog high (${endFaultBacklog.toFixed(0)} vs baseline ${baselineBacklog}) but flat (${growthPerMin.toFixed(1)}/min): saturated, bounded`
      : `backlog stayed near baseline (${endFaultBacklog.toFixed(0)} vs ${baselineBacklog})`;
  return { pileup, baselineBacklog, peakBacklog, endFaultBacklog, growthPerMin, reason };
}

export interface Recovery {
  recovered: boolean;
  /** ms from the end of the fault to the first sample of a calm run, or null. */
  recoveryMs: number | null;
  /** The thresholds a calm sample had to meet. */
  thresholds: { cpuPercent: number; backlog: number; orphanSubs: number };
}

/**
 * Recovered = `calmSamples` consecutive recovery samples that are all at or
 * below the thresholds: CPU ≤ max(1.5 × baseline p95, baseline p95 + 50),
 * backlog ≤ baseline p95 + 2, orphaned subscriptions ≤ baseline max + 2.
 * The recovery time is from the end of the fault to the first of those samples.
 */
export function recoveryTime(samples: FaultSample[], calmSamples = 10): Recovery {
  const base = samples.filter((s) => s.phase === "baseline");
  const cpu95 = base.length ? percentile(base.map((s) => s.cpuPercent), 0.95) : 0;
  const thresholds = {
    cpuPercent: Math.max(1.5 * cpu95, cpu95 + 50),
    backlog: (base.length ? percentile(base.map(backlog), 0.95) : 0) + 2,
    orphanSubs: (base.length ? Math.max(...base.map(orphanSubs)) : 0) + 2,
  };
  const faultEnd = Math.max(-Infinity, ...samples.filter((s) => s.phase === "fault").map((s) => s.tMs));
  const rec = samples.filter((s) => s.phase === "recovery");
  if (rec.length === 0 || !Number.isFinite(faultEnd)) return { recovered: false, recoveryMs: null, thresholds };
  const calm = (s: FaultSample) =>
    s.cpuPercent <= thresholds.cpuPercent && backlog(s) <= thresholds.backlog && orphanSubs(s) <= thresholds.orphanSubs;
  let run = 0;
  for (let i = 0; i < rec.length; i++) {
    run = calm(rec[i]) ? run + 1 : 0;
    if (run >= calmSamples) {
      const first = rec[i - calmSamples + 1];
      return { recovered: true, recoveryMs: Math.max(0, first.tMs - faultEnd), thresholds };
    }
  }
  return { recovered: false, recoveryMs: null, thresholds };
}

/**
 * Executor log lines that change the registered-subscription count
 * (rust-executor/src/perspectives/perspective_instance/subscriptions.rs):
 *   "🔗 subscription <id> created for connection <c> [<uuid>]"  → +1
 *   "🔗 <n> subscription(s) dropped [<uuid>]"                     → −n
 * A subscribe whose first result fails, or that is cancelled while it
 * computes, is removed without a log line, so created − dropped is an upper
 * bound. Also counts SPARQL evaluations stopped by the query deadline.
 */
export interface LogCounts {
  created: number;
  dropped: number;
  deadlineStops: number;
}

export function emptyLogCounts(): LogCounts {
  return { created: 0, dropped: 0, deadlineStops: 0 };
}

export function countLogLine(line: string, c: LogCounts): void {
  if (/subscription \S+ created for connection/.test(line)) {
    c.created++;
    return;
  }
  const d = /(\d+) subscription\(s\) dropped/.exec(line);
  if (d) {
    c.dropped += parseInt(d[1], 10);
    return;
  }
  if (/deadline of .* passed/.test(line)) c.deadlineStops++;
}

/** Split a stream chunk into whole lines, keeping the unfinished tail. */
export function splitLines(carry: string, chunk: string): { lines: string[]; carry: string } {
  const text = carry + chunk;
  const parts = text.split("\n");
  return { lines: parts.slice(0, -1), carry: parts[parts.length - 1] };
}

/**
 * CPU quota for a slowdown factor: the executor gets `1/factor` of one core
 * (CFS quota, `systemctl set-property CPUQuota=`). Factor 1 (or less) means
 * no quota. Returned as the CPUQuota percent, or null for none.
 */
export function quotaPercentForSlowdown(factor: number): number | null {
  if (!(factor > 1)) return null;
  return Math.max(1, Math.round(100 / factor));
}

/** Parse `F1_LEVELS` like "1,4,20,100". */
export function parseLevels(s: string | undefined, dflt: number[]): number[] {
  if (!s) return dflt;
  const v = s.split(",").map((x) => Number(x.trim()));
  if (v.some((x) => !Number.isFinite(x) || x < 1)) throw new Error(`levels "${s}" must be numbers ≥ 1`);
  return v;
}

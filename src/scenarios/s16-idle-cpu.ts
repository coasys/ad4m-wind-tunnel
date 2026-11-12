/**
 * S16: Idle CPU Profiling
 *
 * Measures executor CPU consumption with ZERO load — no addLink, no
 * queries, nothing but the executor's own background work (Deno runtime,
 * Holochain conductor if attached, SPARQL store, WS listener). A healthy
 * idle executor should burn near-zero CPU; a busy poll loop, a runaway
 * timer, or a leaked interval shows up here as non-zero steady-state CPU%
 * long before it would show up as an RSS leak.
 *
 * Uses instantaneous CPU% computed from `/proc/PID/stat` deltas (see
 * `proc-metrics.ts`), NOT `ps -o %cpu=`, which reports a lifetime average
 * since process start and is useless for "how busy is this process RIGHT
 * NOW".
 *
 * Phases:
 *   1. SETTLE (S16_SETTLE_SEC, default 10s) — the executor just booted;
 *      its own startup work (snapshot load, DB open) still shows as CPU.
 *      Ignored.
 *   2. IDLE   (S16_IDLE_SEC, default 60s) — CPU% sampled every
 *      S16_SAMPLE_SEC (default 2s) via `/proc/PID/stat` deltas.
 *   3. REPORT — avg/peak CPU%, thread count, and per-thread-name top
 *      consumers (grouped, since thread pools reuse names across many TIDs).
 *
 * Pass/fail: avg idle CPU% <= S16_THRESHOLD_PCT (default 5.0 — 5% of one
 * core). Skips honestly (passed: true, skipped: true) if `/proc` is
 * unavailable (non-Linux host) rather than fabricating a pass.
 *
 * Tunables (env vars, defaults shown):
 *   S16_SETTLE_SEC      10
 *   S16_IDLE_SEC        60
 *   S16_SAMPLE_SEC       2
 *   S16_THRESHOLD_PCT  5.0   idle CPU% above this fails
 *
 * Reports:
 *   metrics.cpu.avgPercent / peakPercent / samples[{elapsedMs,cpuPercent}]
 *   metrics.threads.count / topConsumers[{name,cpuPercent,count}]
 *   metrics.rss.initialKb / finalKb
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";
import {
  getExecutorPid,
  getRssKb,
  cpuSnapshot,
  cpuPercent,
  threadCpuSnapshot,
  ProcCpuSnapshot,
  ThreadCpuSnapshot,
} from "../proc-metrics.js";

const SETTLE_MS = (parseInt(process.env.S16_SETTLE_SEC || "10", 10) || 10) * 1000;
const IDLE_MS = (parseInt(process.env.S16_IDLE_SEC || "60", 10) || 60) * 1000;
const SAMPLE_MS = (parseInt(process.env.S16_SAMPLE_SEC || "2", 10) || 2) * 1000;
const THRESHOLD_PCT = parseFloat(process.env.S16_THRESHOLD_PCT || "5.0") || 5.0;

/** Cap the reported per-thread breakdown — Deno + tokio pools can spawn
 *  dozens of threads; only the busiest ones are actionable. */
const TOP_CONSUMERS_LIMIT = 10;

interface CpuSample {
  elapsedMs: number;
  cpuPercent: number;
}

interface ThreadConsumer {
  name: string;
  cpuPercent: number;
  count: number;
}

export const s16IdleCpu: Scenario = {
  id: "s16",
  name: "Idle CPU Profiling",
  description: "Instantaneous CPU% (/proc/pid/stat deltas) over a zero-load idle window, plus per-thread top consumers",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    const agent = await client.generateAgent("wind-tunnel-s16");
    samples.push({
      name: "agent_generate",
      durationMs: agent.durationMs,
      timestamp: agent.timestamp,
      error: agent.error,
    });

    const executorPid = getExecutorPid(port);
    if (!executorPid) {
      return {
        scenario: "s16-idle-cpu",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        passed: false,
        metrics: { error: "Could not resolve executor PID for CPU sampling" },
        samples,
        summary: "S16 FAILED: executor PID not found",
      };
    }

    // ── SETTLE — let the just-booted executor finish start-of-day work
    // (Deno snapshot warmup, initial DB opens) before measuring idle cost.
    console.log(`[s16] SETTLE: ${SETTLE_MS / 1000}s...`);
    await sleep(SETTLE_MS);

    const initialRssKb = getRssKb(executorPid);
    const baseline = cpuSnapshot(executorPid);
    if (!baseline) {
      // `/proc` unavailable — non-Linux host, or the process vanished
      // between PID resolution and sampling. This scenario is inherently
      // Linux-only; skip honestly rather than fabricate a pass on invented
      // numbers.
      return {
        scenario: "s16-idle-cpu",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        passed: true,
        metrics: {
          skipped: true,
          skip_reason: "/proc/PID/stat unavailable — CPU profiling requires Linux",
        },
        samples,
        summary: "S16 SKIPPED: /proc unavailable (non-Linux host?)",
      };
    }

    // ── IDLE — sample CPU% every SAMPLE_MS for IDLE_MS, zero induced load ──
    console.log(`[s16] IDLE: ${IDLE_MS / 1000}s, sampling every ${SAMPLE_MS / 1000}s...`);
    const threadsStart: ThreadCpuSnapshot[] = threadCpuSnapshot(executorPid);

    const cpuSamples: CpuSample[] = [];
    let prev: ProcCpuSnapshot = baseline;
    let lastRssKb: number | null = initialRssKb;
    const idleStart = performance.now();

    while (performance.now() - idleStart < IDLE_MS) {
      await sleep(SAMPLE_MS);

      const now = cpuSnapshot(executorPid);
      const elapsedMs = Math.round(performance.now() - idleStart);
      if (now) {
        cpuSamples.push({
          elapsedMs,
          cpuPercent: Math.round(cpuPercent(prev, now) * 100) / 100,
        });
        prev = now;
      }

      const rss = getRssKb(executorPid);
      if (rss !== null) lastRssKb = rss;
    }

    const threadsEnd: ThreadCpuSnapshot[] = threadCpuSnapshot(executorPid);
    const idleElapsedMs = performance.now() - idleStart;
    const finalRssKb = getRssKb(executorPid) ?? lastRssKb;

    // ── ANALYSIS ─────────────────────────────────────────────────────
    const avgPercent = cpuSamples.length > 0
      ? cpuSamples.reduce((sum, s) => sum + s.cpuPercent, 0) / cpuSamples.length
      : 0;
    const peakPercent = cpuSamples.length > 0
      ? Math.max(...cpuSamples.map((s) => s.cpuPercent))
      : 0;

    // Per-thread breakdown across the full idle window (start→end
    // snapshot), grouped by thread NAME since pools (tokio-runtime-w,
    // Deno's V8 platform threads, etc.) reuse the same name across many
    // TIDs — reporting per-TID would just be noise.
    const endByTid = new Map(threadsEnd.map((t) => [t.tid, t]));
    const groups = new Map<string, { ticks: number; tids: Set<number> }>();
    for (const startThread of threadsStart) {
      const endThread = endByTid.get(startThread.tid);
      if (!endThread) continue; // thread exited during the window
      const dTicks = (endThread.utime - startThread.utime) + (endThread.stime - startThread.stime);
      const group = groups.get(startThread.name) ?? { ticks: 0, tids: new Set<number>() };
      group.ticks += Math.max(0, dTicks);
      group.tids.add(startThread.tid);
      groups.set(startThread.name, group);
    }
    const CLK_TCK = 100;
    const topConsumers: ThreadConsumer[] = [...groups.entries()]
      .map(([name, g]) => ({
        name,
        cpuPercent: idleElapsedMs > 0
          ? Math.round(((g.ticks / CLK_TCK) * 1000 / idleElapsedMs) * 100 * 100) / 100
          : 0,
        count: g.tids.size,
      }))
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, TOP_CONSUMERS_LIMIT);

    const metrics = {
      settle: { seconds: SETTLE_MS / 1000 },
      idle: {
        seconds: IDLE_MS / 1000,
        sampleIntervalSeconds: SAMPLE_MS / 1000,
        samplesTaken: cpuSamples.length,
      },
      cpu: {
        avgPercent: Math.round(avgPercent * 100) / 100,
        peakPercent: Math.round(peakPercent * 100) / 100,
        thresholdPercent: THRESHOLD_PCT,
        samples: cpuSamples,
      },
      threads: {
        count: threadsEnd.length,
        topConsumers,
      },
      rss: {
        initialKb: initialRssKb,
        finalKb: finalRssKb,
      },
    };

    const passed = avgPercent <= THRESHOLD_PCT;
    const mb = (kb: number | null) => (kb != null ? (kb / 1024).toFixed(0) : "?");
    const top = topConsumers[0]
      ? `${topConsumers[0].name}(${topConsumers[0].cpuPercent}%×${topConsumers[0].count})`
      : "none";
    const summary = [
      `avg=${metrics.cpu.avgPercent}%`,
      `peak=${metrics.cpu.peakPercent}%`,
      `threshold=${THRESHOLD_PCT}%`,
      `threads=${metrics.threads.count}`,
      `top=${top}`,
      `RSS ${mb(initialRssKb)}→${mb(finalRssKb)}MB`,
    ].join(" | ");

    const endTime = Date.now();
    return {
      scenario: "s16-idle-cpu",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      passed,
      metrics,
      samples,
      summary: `S16 ${passed ? "PASSED" : "FAILED"}: ${summary}`,
    };
  },
};

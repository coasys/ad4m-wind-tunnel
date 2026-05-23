/**
 * S15: Leak Attribution (Fast)
 *
 * Three-phase test to localise WHICH operation type is responsible for
 * monitor-phase RSS growth. Runs in ~4 minutes (vs S9's ~8 minutes per
 * mode) and produces a per-phase slope that pinpoints the leak source.
 *
 *   1. SEED      2,000 links to give the SPARQL store something to query
 *   2. IDLE      90s of nothing — establishes the allocator-noise baseline
 *   3. WRITES    90s of 5 addLink/s — write-path-only contribution
 *   4. QUERIES   90s of 5 addLink/s + 1 query/5s — adds the query path
 *
 * Compute least-squares slope per phase. Reports:
 *   - idle_slope_mb_per_min       (baseline / allocator behavior)
 *   - write_slope_mb_per_min      (addLink contribution)
 *   - write_query_slope_mb_per_min (addLink + query)
 *   - query_contribution_mb_per_min = write_query_slope - write_slope
 *
 * If write_slope ≈ idle_slope, addLink is clean.
 * If write_query_slope >> write_slope, the query path is leaking.
 * If both are above idle_slope, both paths leak — proportionally.
 *
 * Use S9 for high-fidelity verification under realistic Holochain load;
 * use S15 in inner-loop development for fast regression detection.
 *
 * Tunables (env vars, defaults shown):
 *   S15_SEED          2000
 *   S15_PHASE_SEC      90       per-phase duration
 *   S15_WRITE_RATE      5       addLinks per second in WRITE/QUERY phases
 *   S15_QUERY_INTERVAL_SEC 5    query period during QUERY phase
 *   S15_RSS_INTERVAL_SEC 2      RSS sample period
 */

import { execSync } from "child_process";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";

const SEED_LINKS = parseInt(process.env.S15_SEED || "2000", 10) || 2000;
// 60s per phase × 3 phases + setup/seed ≈ 3.5 min total. With 1 RSS sample
// every 2s that's 30 samples per phase — robust enough for a 1 MB/min slope
// threshold and short enough for inner-loop dev iteration.
const PHASE_MS = (parseInt(process.env.S15_PHASE_SEC || "60", 10) || 60) * 1000;
const WRITE_RATE_PER_SEC = parseInt(process.env.S15_WRITE_RATE || "5", 10) || 5;
const QUERY_INTERVAL_MS =
  (parseInt(process.env.S15_QUERY_INTERVAL_SEC || "5", 10) || 5) * 1000;
const RSS_INTERVAL_MS =
  (parseInt(process.env.S15_RSS_INTERVAL_SEC || "2", 10) || 2) * 1000;
const LEAK_THRESHOLD_MB_PER_MIN = 1;

type Phase = "setup" | "seed" | "idle" | "writes" | "queries";

function getRssKb(pid: number): number | null {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8", timeout: 5000 });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function getExecutorPid(port: number): number | null {
  try {
    const out = execSync(`lsof -ti :${port} 2>/dev/null || true`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (!out) return null;
    const n = parseInt(out.split("\n")[0], 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function linearSlope(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { x, y } of points) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

interface PhaseStats {
  samples: number;
  startKb: number | null;
  endKb: number | null;
  slopeMbPerMin: number;
}

export const s15LeakAttribution: Scenario = {
  id: "s15",
  name: "Leak Attribution",
  description: "Fast 3-phase (idle / writes / writes+queries) RSS slope attribution",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    const executorPid = getExecutorPid(port);
    if (!executorPid) {
      return {
        scenario: "s15-leak-attribution",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: "Could not resolve executor PID for RSS sampling" },
        samples,
        summary: "S15 FAILED: executor PID not found",
      };
    }

    type RssSample = { elapsedMs: number; rssKb: number; phase: Phase };
    const rssSamples: RssSample[] = [];
    const runStart = performance.now();
    const sampleRss = (phase: Phase) => {
      const rss = getRssKb(executorPid);
      if (rss !== null) {
        rssSamples.push({ elapsedMs: performance.now() - runStart, rssKb: rss, phase });
      }
    };

    sampleRss("setup");
    const agent = await client.generateAgent("wind-tunnel-s15");
    samples.push({ name: "agent_generate", durationMs: agent.durationMs, timestamp: agent.timestamp, error: agent.error });

    const persp = await client.createPerspective("s15-attribution");
    samples.push({ name: "perspective_create", durationMs: persp.durationMs, timestamp: persp.timestamp, error: persp.error });
    if (persp.error) {
      return {
        scenario: "s15-leak-attribution",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: persp.error },
        samples,
        summary: `S15 FAILED at perspective create: ${persp.error}`,
      };
    }
    const uuid = persp.data?.uuid || persp.data?.id;
    sampleRss("setup");

    // ── Phase 1: SEED — give the store something to query ───────────
    console.log(`[s15] Seeding ${SEED_LINKS} links...`);
    const seedStart = performance.now();
    const seedLatencies: number[] = [];
    for (let i = 0; i < SEED_LINKS; i++) {
      const r = await client.addLink(
        uuid,
        `ad4m://s15-seed/${i % 50}`,
        "flux://has_message",
        `literal://s15-seed-${i}`
      );
      seedLatencies.push(r.durationMs);
    }
    const seedDurationMs = performance.now() - seedStart;
    sampleRss("seed");
    samples.push({ name: "seed_phase", durationMs: seedDurationMs, timestamp: Date.now() });
    console.log(`[s15] Seed complete: ${SEED_LINKS} links in ${(seedDurationMs / 1000).toFixed(1)}s`);

    // Quick drain — give the allocator a moment to settle before measuring.
    await sleep(2000);

    // ── Phase 2: IDLE — baseline ────────────────────────────────────
    console.log(`[s15] IDLE phase: ${PHASE_MS / 1000}s of nothing...`);
    const idleStart = performance.now();
    while (performance.now() - idleStart < PHASE_MS) {
      sampleRss("idle");
      await sleep(RSS_INTERVAL_MS);
    }

    // ── Phase 3: WRITES — addLink only ──────────────────────────────
    console.log(`[s15] WRITES phase: ${WRITE_RATE_PER_SEC} addLink/s for ${PHASE_MS / 1000}s...`);
    let writeCount = 0;
    let lastRssAt = -RSS_INTERVAL_MS;
    let lastWriteAt = -1000 / WRITE_RATE_PER_SEC;
    const writeLatencies: number[] = [];
    const writeIntervalMs = 1000 / WRITE_RATE_PER_SEC;
    const writesStart = performance.now();
    while (performance.now() - writesStart < PHASE_MS) {
      const elapsed = performance.now() - writesStart;
      if (elapsed - lastWriteAt >= writeIntervalMs) {
        lastWriteAt = elapsed;
        const r = await client.addLink(
          uuid,
          `ad4m://s15-write/${writeCount % 50}`,
          "flux://has_message",
          `literal://s15-w-${writeCount}`
        );
        writeLatencies.push(r.durationMs);
        writeCount++;
      }
      if (elapsed - lastRssAt >= RSS_INTERVAL_MS) {
        lastRssAt = elapsed;
        sampleRss("writes");
      }
      await sleep(20);
    }

    // ── Phase 4: QUERIES — addLink + queryLinks ─────────────────────
    console.log(`[s15] QUERIES phase: ${WRITE_RATE_PER_SEC} addLink/s + query every ${QUERY_INTERVAL_MS / 1000}s for ${PHASE_MS / 1000}s...`);
    let qWriteCount = 0;
    let queryCount = 0;
    lastRssAt = -RSS_INTERVAL_MS;
    lastWriteAt = -writeIntervalMs;
    let lastQueryAt = -QUERY_INTERVAL_MS;
    const queryWriteLatencies: number[] = [];
    const queryLatencies: number[] = [];
    const queriesStart = performance.now();
    while (performance.now() - queriesStart < PHASE_MS) {
      const elapsed = performance.now() - queriesStart;
      if (elapsed - lastWriteAt >= writeIntervalMs) {
        lastWriteAt = elapsed;
        const r = await client.addLink(
          uuid,
          `ad4m://s15-q/${qWriteCount % 50}`,
          "flux://has_message",
          `literal://s15-q-${qWriteCount}`
        );
        queryWriteLatencies.push(r.durationMs);
        qWriteCount++;
      }
      if (elapsed - lastQueryAt >= QUERY_INTERVAL_MS) {
        lastQueryAt = elapsed;
        const r = await client.queryLinks(uuid, { predicate: "flux://has_message" });
        queryLatencies.push(r.durationMs);
        queryCount++;
      }
      if (elapsed - lastRssAt >= RSS_INTERVAL_MS) {
        lastRssAt = elapsed;
        sampleRss("queries");
      }
      await sleep(20);
    }

    const endTime = Date.now();

    // ── Analysis ─────────────────────────────────────────────────────
    const statsFor = (phase: Phase): PhaseStats => {
      const phaseSamples = rssSamples.filter((s) => s.phase === phase);
      if (phaseSamples.length < 2) {
        return { samples: phaseSamples.length, startKb: phaseSamples[0]?.rssKb ?? null, endKb: phaseSamples[0]?.rssKb ?? null, slopeMbPerMin: 0 };
      }
      const slopeKbPerMs = linearSlope(phaseSamples.map((s) => ({ x: s.elapsedMs, y: s.rssKb })));
      const mbPerMin = (slopeKbPerMs * 60_000) / 1024;
      return {
        samples: phaseSamples.length,
        startKb: phaseSamples[0].rssKb,
        endKb: phaseSamples[phaseSamples.length - 1].rssKb,
        slopeMbPerMin: Math.round(mbPerMin * 100) / 100,
      };
    };

    const idle = statsFor("idle");
    const writes = statsFor("writes");
    const queries = statsFor("queries");

    const writeContribution = Math.round((writes.slopeMbPerMin - idle.slopeMbPerMin) * 100) / 100;
    const queryContribution = Math.round((queries.slopeMbPerMin - writes.slopeMbPerMin) * 100) / 100;

    const verdict = (slope: number) => {
      const abs = Math.abs(slope);
      if (abs < 0.25) return "clean";
      if (abs < LEAK_THRESHOLD_MB_PER_MIN) return "slow_growth";
      return "leaking";
    };

    const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

    const metrics = {
      seed: {
        links: SEED_LINKS,
        durationMs: Math.round(seedDurationMs),
        avgLinkAddMs: Math.round(avg(seedLatencies) * 100) / 100,
      },
      idle,
      writes: {
        ...writes,
        addLinkCount: writeCount,
        avgLinkAddMs: Math.round(avg(writeLatencies) * 100) / 100,
      },
      queries: {
        ...queries,
        addLinkCount: qWriteCount,
        queryCount,
        avgLinkAddMs: Math.round(avg(queryWriteLatencies) * 100) / 100,
        avgQueryMs: Math.round(avg(queryLatencies) * 100) / 100,
      },
      attribution: {
        writePathMbPerMin: writeContribution,
        queryPathMbPerMin: queryContribution,
        writeVerdict: verdict(writeContribution),
        queryVerdict: verdict(queryContribution),
      },
      rss: {
        samples: rssSamples.map((s) => ({ elapsedMs: Math.round(s.elapsedMs), rssKb: s.rssKb, phase: s.phase })),
      },
    };

    const mb = (kb: number | null | undefined) => kb != null ? (kb / 1024).toFixed(0) : "?";
    const summary = [
      `seed=${SEED_LINKS} (${(seedDurationMs / 1000).toFixed(1)}s)`,
      `idle=${idle.slopeMbPerMin}MB/min`,
      `writes=${writes.slopeMbPerMin}MB/min (${verdict(writeContribution)})`,
      `queries=${queries.slopeMbPerMin}MB/min (${verdict(queryContribution)})`,
      `writePath=${writeContribution}MB/min  queryPath=${queryContribution}MB/min`,
      `RSS: idle=${mb(idle.startKb)}→${mb(idle.endKb)}  writes=${mb(writes.startKb)}→${mb(writes.endKb)}  queries=${mb(queries.startKb)}→${mb(queries.endKb)}`,
    ].join(" | ");

    return {
      scenario: "s15-leak-attribution",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary,
    };
  },
};

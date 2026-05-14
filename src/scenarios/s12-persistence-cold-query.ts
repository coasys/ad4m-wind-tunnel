/**
 * S12: Persistence & Cold Query
 * Measures query performance on warm data after executor restart.
 * - Seed perspective with configurable link count (default 100K)
 * - Stop executor gracefully
 * - Restart, measure time-to-healthy with data vs empty
 * - Query immediately after health: queryAll, queryBySource, count
 * - Measure startup time delta, first query latency, warm-up curve (10 sequential queries)
 * - Compare across branches (Oxigraph vs SurrealDB disk format)
 */

import { spawn, execSync, ChildProcess } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { waitForHealth, sleep } from "../executor.js";
import { InstrumentedClient } from "../client.js";

const SEED_LINK_COUNT = 100_000;
const BATCH_SIZE = 500;
const WARMUP_QUERIES = 10;

function getRssKb(pid: number): number {
  try {
    const output = execSync(`ps -o rss= -p ${pid}`).toString().trim();
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * Start executor WITHOUT wiping data (unlike the standard startExecutor which calls init).
 */
function startExecutorRaw(
  binaryPath: string,
  dataPath: string,
  port: number,
  adminToken: string
): ChildProcess {
  const proc = spawn(binaryPath, [
    "run",
    "--app-data-path", dataPath,
    "--port", String(port),
    "--admin-credential", adminToken,
    "--run-dapp-server", "false",
    "--hc-use-bootstrap", "false",
    "--hc-use-proxy", "false",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "info" },
  });

  proc.stdout?.on("data", (d) => {
    const line = d.toString().trim();
    if (line && process.env.VERBOSE) console.log(`[exec:${port}:out] ${line}`);
  });
  proc.stderr?.on("data", (d) => {
    const line = d.toString().trim();
    if (line && process.env.VERBOSE) console.log(`[exec:${port}:err] ${line}`);
  });

  return proc;
}

function stopProc(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc || proc.killed) { resolve(); return; }
    proc.on("exit", () => resolve());
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
      resolve();
    }, 10000);
  });
}

export const s12PersistenceColdQuery: Scenario = {
  id: "s12",
  name: "Persistence & Cold Query",
  description: "Query performance on warm data after restart; startup time with data vs empty",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Derive binary path from known build directory pattern
    const branchDir = branch.replace(/\//g, "-");
    const binaryPath = join(ctx.tmpDirBase, `ad4m-build-${branchDir}`, "target", "release", "ad4m-executor");

    if (!existsSync(binaryPath)) {
      return {
        scenario: "s12-persistence-cold-query",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: `Cannot find executor binary for restart: ${binaryPath}` },
        samples,
        summary: `S12 FAILED: no binary`,
      };
    }

    const adminToken = client.config.adminToken;
    const dataPath = join(ctx.tmpDirBase, `ad4m-wt-s12-persist-${branch.replace(/\//g, "-")}`);

    // Phase 1: Measure empty startup time (baseline)
    console.log(`[s12] Phase 1: Empty startup baseline...`);
    if (existsSync(dataPath)) rmSync(dataPath, { recursive: true, force: true });
    mkdirSync(dataPath, { recursive: true });

    // Init the data directory
    try {
      execSync(`"${binaryPath}" init --data-path "${dataPath}" 2>&1`, { stdio: "pipe", timeout: 30000 });
    } catch (err: any) {
      return {
        scenario: "s12-persistence-cold-query",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: `Init failed: ${err.message}` },
        samples,
        summary: `S12 FAILED: init error`,
      };
    }

    const emptyPort = port + 5; // Use a different port to avoid conflict with running executor
    let proc = startExecutorRaw(binaryPath, dataPath, emptyPort, adminToken);
    const emptyStartMs = await waitForHealth(emptyPort, 120000, adminToken);
    console.log(`[s12] Empty startup: ${emptyStartMs.toFixed(0)}ms`);

    samples.push({ name: "empty_startup", durationMs: emptyStartMs, timestamp: Date.now() });

    // Create a client for seeding
    const seedClient = new InstrumentedClient({ port: emptyPort, adminToken });
    await seedClient.connect();

    // Setup agent and perspective
    await seedClient.generateAgent("wind-tunnel-persistence");
    const perspective = await seedClient.createPerspective("persistence-test");
    if (perspective.error) {
      await stopProc(proc);
      return {
        scenario: "s12-persistence-cold-query",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: perspective.error },
        samples,
        summary: `S12 FAILED: ${perspective.error}`,
      };
    }

    const uuid = perspective.data?.uuid || perspective.data?.id;

    // Phase 2: Seed links
    console.log(`[s12] Phase 2: Seeding ${SEED_LINK_COUNT} links...`);
    const seedStart = performance.now();
    let seeded = 0;
    const sourcePool: string[] = [];
    for (let i = 0; i < 200; i++) sourcePool.push(`ad4m://source-${i}`);

    for (let i = 0; i < SEED_LINK_COUNT; i++) {
      const source = sourcePool[i % sourcePool.length];
      await seedClient.addLink(uuid, source, "ad4m://has", `literal://data-${i}`);
      seeded++;
      if (seeded % 5000 === 0) {
        console.log(`[s12]   Seeded ${seeded}/${SEED_LINK_COUNT}...`);
      }
    }
    const seedDurationMs = performance.now() - seedStart;
    console.log(`[s12] Seeding complete: ${seeded} links in ${(seedDurationMs / 1000).toFixed(1)}s`);

    samples.push({ name: "seed_links", durationMs: seedDurationMs, timestamp: Date.now() });

    // Get RSS after seeding
    let rssAfterSeed = 0;
    try {
      const pid = execSync(`lsof -ti :${emptyPort} 2>/dev/null`).toString().trim().split("\n")[0];
      if (pid) rssAfterSeed = getRssKb(parseInt(pid, 10));
    } catch {}

    // Phase 3: Stop executor gracefully
    console.log(`[s12] Phase 3: Stopping executor...`);
    await seedClient.disconnect();
    await stopProc(proc);
    await sleep(3000); // Let it fully shut down

    // Phase 4: Restart and measure time-to-healthy with data
    console.log(`[s12] Phase 4: Cold restart with ${SEED_LINK_COUNT} links...`);
    const coldRestartPort = emptyPort; // Reuse same port now it's stopped
    proc = startExecutorRaw(binaryPath, dataPath, coldRestartPort, adminToken);
    const dataStartMs = await waitForHealth(coldRestartPort, 300000, adminToken); // 5min timeout for large data
    console.log(`[s12] Cold restart with data: ${dataStartMs.toFixed(0)}ms`);

    samples.push({ name: "cold_restart_with_data", durationMs: dataStartMs, timestamp: Date.now() });

    // Phase 5: Immediate queries after health
    console.log(`[s12] Phase 5: Cold query performance...`);
    const coldClient = new InstrumentedClient({ port: coldRestartPort, adminToken });
    await coldClient.connect();

    // Query all (may be expensive)
    const queryAllResult = await coldClient.timed(async () => {
      const r = await coldClient.queryLinks(uuid, {});
      return r.data;
    });
    samples.push({ name: "cold_query_all", durationMs: queryAllResult.durationMs, timestamp: Date.now() });

    // Query by source
    const queryBySourceResult = await coldClient.timed(async () => {
      const r = await coldClient.queryLinks(uuid, { source: sourcePool[0] });
      return r.data;
    });
    samples.push({ name: "cold_query_by_source", durationMs: queryBySourceResult.durationMs, timestamp: Date.now() });

    // Query count (via queryAll length as proxy)
    const queryCountResult = await coldClient.timed(async () => {
      const r = await coldClient.queryLinks(uuid, { predicate: "ad4m://has" });
      return r.data;
    });
    samples.push({ name: "cold_query_by_predicate", durationMs: queryCountResult.durationMs, timestamp: Date.now() });

    // Phase 6: Warm-up curve — 10 sequential queries
    console.log(`[s12] Phase 6: Warm-up curve (${WARMUP_QUERIES} queries)...`);
    const warmupLatencies: number[] = [];
    for (let i = 0; i < WARMUP_QUERIES; i++) {
      const source = sourcePool[i % sourcePool.length];
      const r = await coldClient.queryLinks(uuid, { source });
      warmupLatencies.push(r.durationMs);
      samples.push({ name: `warmup_query_${i}`, durationMs: r.durationMs, timestamp: Date.now() });
    }

    // Get RSS after cold restart and queries
    let rssAfterCold = 0;
    try {
      const pid = execSync(`lsof -ti :${coldRestartPort} 2>/dev/null`).toString().trim().split("\n")[0];
      if (pid) rssAfterCold = getRssKb(parseInt(pid, 10));
    } catch {}

    // Cleanup
    await coldClient.disconnect();
    await stopProc(proc);
    await sleep(2000);
    if (existsSync(dataPath)) rmSync(dataPath, { recursive: true, force: true });

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    const startupTimeDelta = dataStartMs - emptyStartMs;
    const warmupSorted = [...warmupLatencies].sort((a, b) => a - b);

    const metrics = {
      seedLinkCount: SEED_LINK_COUNT,
      seedDurationMs: Math.round(seedDurationMs),
      seedThroughputLinksPerSec: Math.round((SEED_LINK_COUNT / (seedDurationMs / 1000)) * 10) / 10,
      emptyStartupMs: Math.round(emptyStartMs),
      coldRestartMs: Math.round(dataStartMs),
      startupTimeDeltaMs: Math.round(startupTimeDelta),
      startupSlowdownFactor: emptyStartMs > 0 ? Math.round((dataStartMs / emptyStartMs) * 100) / 100 : 0,
      coldQueryAllMs: Math.round(queryAllResult.durationMs * 100) / 100,
      coldQueryBySourceMs: Math.round(queryBySourceResult.durationMs * 100) / 100,
      coldQueryByPredicateMs: Math.round(queryCountResult.durationMs * 100) / 100,
      warmupLatenciesMs: warmupLatencies.map((l) => Math.round(l * 100) / 100),
      warmupP50Ms: Math.round(percentile(warmupSorted, 0.5) * 100) / 100,
      warmupFirstMs: warmupLatencies[0] ? Math.round(warmupLatencies[0] * 100) / 100 : 0,
      warmupLastMs: warmupLatencies[warmupLatencies.length - 1] ? Math.round(warmupLatencies[warmupLatencies.length - 1] * 100) / 100 : 0,
      warmupImprovement: warmupLatencies[0] && warmupLatencies[warmupLatencies.length - 1]
        ? Math.round((warmupLatencies[0] / warmupLatencies[warmupLatencies.length - 1]) * 100) / 100
        : 0,
      rssAfterSeedMb: Math.round(rssAfterSeed / 1024),
      rssAfterColdMb: Math.round(rssAfterCold / 1024),
    };

    const summary = [
      `${SEED_LINK_COUNT} links seeded.`,
      `Startup: empty=${emptyStartMs.toFixed(0)}ms, cold=${dataStartMs.toFixed(0)}ms (${(dataStartMs / emptyStartMs).toFixed(1)}x slower).`,
      `Cold queryAll: ${queryAllResult.durationMs.toFixed(0)}ms, bySource: ${queryBySourceResult.durationMs.toFixed(0)}ms.`,
      `Warmup: first=${warmupLatencies[0]?.toFixed(0)}ms → last=${warmupLatencies[warmupLatencies.length - 1]?.toFixed(0)}ms.`,
    ].join(" ");

    return {
      scenario: "s12-persistence-cold-query",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      metrics,
      samples,
      summary,
    };
  },
};

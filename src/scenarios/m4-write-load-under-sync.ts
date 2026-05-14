/**
 * M4: Write Load Under Sync
 * Uses the executor provided by the runner + starts a 2nd executor.
 * Measures cross-interference under sustained write load.
 * Since neighbourhood sync requires link language installation,
 * this runs as an isolation/interference test with independent perspectives.
 */

import { execSync } from "child_process";
import { join } from "path";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { startExecutor, waitForHealth, stopExecutor, sleep, ExecutorConfig } from "../executor.js";
import { InstrumentedClient } from "../client.js";

function getRssKb(pid: number): number {
  try {
    const output = execSync(`ps -o rss= -p ${pid}`).toString().trim();
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

function getExecutorPid(port: number): number {
  try {
    const output = execSync(`lsof -ti :${port} 2>/dev/null || true`).toString().trim();
    if (output) return parseInt(output.split("\n")[0], 10);
  } catch {}
  return 0;
}

function computeStats(latencies: number[]) {
  if (latencies.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const count = sorted.length;
  return {
    avg: Math.round((sorted.reduce((a, b) => a + b, 0) / count) * 100) / 100,
    p50: Math.round(sorted[Math.floor(count * 0.5)] * 100) / 100,
    p95: Math.round(sorted[Math.floor(count * 0.95)] * 100) / 100,
    p99: Math.round(sorted[Math.floor(count * 0.99)] * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[count - 1] * 100) / 100,
  };
}

export const m4WriteLoadUnderSync: Scenario = {
  id: "m4",
  name: "Write Load Under Sync",
  description: "Two executors under sustained write load — measure cross-interference and degradation",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    const branchDirName = branch.replace(/\//g, "-");
    const binaryPath = join(ctx.tmpDirBase, `ad4m-build-${branchDirName}`, "target", "release", "ad4m-executor");

    const port2 = port + 1;
    let proc2: any = null;

    try {
      // Executor 1 is already running (provided by runner context)
      // Start executor 2
      console.log(`[m4] Starting executor 2 on port ${port2}...`);
      const dataPath2 = join(ctx.tmpDirBase, `ad4m-wt-m4-e2`);
      const config2: ExecutorConfig = {
        branch,
        port: port2,
        dataPath: dataPath2,
        adminToken: ctx.adminToken,
        adamRepoPath: ctx.adamRepoPath,
        buildDir: join(ctx.tmpDirBase, `ad4m-build-${branchDirName}`),
      };
      proc2 = await startExecutor(binaryPath, config2);
      await waitForHealth(port2, 120000, ctx.adminToken);
      console.log("[m4] Executor 2 healthy");

      // Client 1 is already provided
      const client1 = client;
      const client2 = new InstrumentedClient({ port: port2, adminToken: ctx.adminToken });
      await client2.connect();

      // Setup perspectives
      await client1.generateAgent("m4-executor1");
      await client2.generateAgent("m4-executor2");
      const p1 = await client1.createPerspective("m4-e1-write");
      const p2 = await client2.createPerspective("m4-e2-write");

      const uuid1 = p1.data?.uuid || p1.data?.id;
      const uuid2 = p2.data?.uuid || p2.data?.id;

      if (!uuid1 || !uuid2) {
        throw new Error(`Failed to create perspectives: e1=${p1.error}, e2=${p2.error}`);
      }

      // Phase 1: Isolated baseline — write to E1 alone
      console.log("[m4] Phase 1: Isolated baseline (E1 writes alone for 15s)...");
      const isolatedLatencies: number[] = [];
      const isolatedStart = performance.now();
      const isolatedDurationMs = 15000;

      while (performance.now() - isolatedStart < isolatedDurationMs) {
        const idx = isolatedLatencies.length;
        const result = await client1.addLink(
          uuid1,
          `ad4m://m4-isolated-${idx % 100}`,
          "flux://has_message",
          `literal://msg-isolated-${idx}`
        );
        isolatedLatencies.push(result.durationMs);
        // Rate limiting: target 10 links/sec = 100ms per link
        const elapsed = performance.now() - isolatedStart;
        const expectedLinks = Math.floor(elapsed / 100);
        if (isolatedLatencies.length > expectedLinks) {
          await sleep(10);
        }
      }

      const isolatedStats = computeStats(isolatedLatencies);
      console.log(`[m4] Isolated: ${isolatedLatencies.length} links, avg=${isolatedStats.avg.toFixed(1)}ms`);

      samples.push({
        name: "phase1_isolated",
        durationMs: performance.now() - isolatedStart,
        timestamp: Date.now(),
      });

      // Phase 2: Concurrent write — both executors writing simultaneously
      console.log("[m4] Phase 2: Concurrent write (both executors, 30s)...");
      const concurrentLatencies1: number[] = [];
      const concurrentLatencies2: number[] = [];
      const concurrentDurationMs = 30000;
      const concurrentStart = performance.now();

      const writer1 = (async () => {
        const start = performance.now();
        while (performance.now() - start < concurrentDurationMs) {
          const idx = concurrentLatencies1.length;
          const result = await client1.addLink(
            uuid1,
            `ad4m://m4-concurrent1-${idx % 100}`,
            "flux://has_message",
            `literal://msg-conc1-${idx}`
          );
          concurrentLatencies1.push(result.durationMs);
          const elapsed = performance.now() - start;
          const expected = Math.floor(elapsed / 100);
          if (concurrentLatencies1.length > expected) await sleep(5);
        }
      })();

      const writer2 = (async () => {
        const start = performance.now();
        while (performance.now() - start < concurrentDurationMs) {
          const idx = concurrentLatencies2.length;
          const result = await client2.addLink(
            uuid2,
            `ad4m://m4-concurrent2-${idx % 100}`,
            "flux://has_reaction",
            `literal://msg-conc2-${idx}`
          );
          concurrentLatencies2.push(result.durationMs);
          const elapsed = performance.now() - start;
          const expected = Math.floor(elapsed / 100);
          if (concurrentLatencies2.length > expected) await sleep(5);
        }
      })();

      await Promise.all([writer1, writer2]);

      const concurrentStats1 = computeStats(concurrentLatencies1);
      const concurrentStats2 = computeStats(concurrentLatencies2);

      console.log(`[m4] Concurrent E1: ${concurrentLatencies1.length} links, avg=${concurrentStats1.avg.toFixed(1)}ms`);
      console.log(`[m4] Concurrent E2: ${concurrentLatencies2.length} links, avg=${concurrentStats2.avg.toFixed(1)}ms`);

      samples.push({
        name: "phase2_concurrent",
        durationMs: performance.now() - concurrentStart,
        timestamp: Date.now(),
      });

      // Phase 3: Sustained pressure — E1 writes at max speed, measure E2 query latency
      console.log("[m4] Phase 3: E1 max write + E2 query interference (15s)...");
      const pressureLatencies: number[] = [];
      const queryLatencies: number[] = [];
      const pressureDurationMs = 15000;
      const pressureStart = performance.now();

      const pressureWriter = (async () => {
        const start = performance.now();
        while (performance.now() - start < pressureDurationMs) {
          const idx = pressureLatencies.length;
          const result = await client1.addLink(
            uuid1,
            `ad4m://m4-pressure-${idx % 200}`,
            "flux://has_message",
            `literal://msg-pressure-${idx}`
          );
          pressureLatencies.push(result.durationMs);
        }
      })();

      const queryProbe = (async () => {
        const start = performance.now();
        while (performance.now() - start < pressureDurationMs) {
          const result = await client2.queryLinks(uuid2, { predicate: "flux://has_reaction" });
          queryLatencies.push(result.durationMs);
          await sleep(500);
        }
      })();

      await Promise.all([pressureWriter, queryProbe]);

      const pressureStats = computeStats(pressureLatencies);
      const queryStats = computeStats(queryLatencies);

      console.log(`[m4] Pressure: ${pressureLatencies.length} links, avg=${pressureStats.avg.toFixed(1)}ms`);
      console.log(`[m4] Query probe: ${queryLatencies.length} queries, avg=${queryStats.avg.toFixed(1)}ms`);

      samples.push({
        name: "phase3_pressure",
        durationMs: performance.now() - pressureStart,
        timestamp: Date.now(),
      });

      // RSS measurements
      const pid1 = getExecutorPid(port);
      const pid2 = getExecutorPid(port2);
      const rss1 = pid1 ? getRssKb(pid1) : 0;
      const rss2 = pid2 ? getRssKb(pid2) : 0;

      await client2.disconnect();

      const endTime = Date.now();
      const totalMs = endTime - startTime;

      const interferenceFactor = isolatedStats.avg > 0
        ? Math.round((concurrentStats1.avg / isolatedStats.avg) * 100) / 100
        : 1;

      const metrics = {
        mode: "isolation_test",
        note: "Neighbourhood sync not available; measuring cross-executor interference via resource contention",
        isolated: { linkCount: isolatedLatencies.length, ...isolatedStats },
        concurrent: {
          executor1: { linkCount: concurrentLatencies1.length, ...concurrentStats1 },
          executor2: { linkCount: concurrentLatencies2.length, ...concurrentStats2 },
        },
        pressure: {
          writerLinks: pressureLatencies.length,
          writerStats: pressureStats,
          queryProbe: { queryCount: queryLatencies.length, ...queryStats },
        },
        interferenceFactor,
        rssAfter: { executor1Kb: rss1, executor2Kb: rss2 },
        totalLinksWritten: isolatedLatencies.length + concurrentLatencies1.length + concurrentLatencies2.length + pressureLatencies.length,
      };

      return {
        scenario: "m4-write-load-under-sync",
        branch,
        startTime,
        endTime,
        durationMs: totalMs,
        metrics,
        samples,
        summary: `Isolation test: isolated=${isolatedStats.avg.toFixed(1)}ms, concurrent=${concurrentStats1.avg.toFixed(1)}ms/${concurrentStats2.avg.toFixed(1)}ms, interference=${interferenceFactor}x. RSS: E1=${(rss1/1024).toFixed(0)}MB, E2=${(rss2/1024).toFixed(0)}MB`,
      };

    } catch (err: any) {
      return {
        scenario: "m4-write-load-under-sync",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: err.message },
        samples,
        summary: `M4 FAILED: ${err.message}`,
      };
    } finally {
      if (proc2) stopExecutor(proc2);
      await sleep(2000);
      try { execSync(`rm -rf "${join(ctx.tmpDirBase, 'ad4m-wt-m4-e2')}"`, { stdio: "pipe" }); } catch {}
    }
  },
};

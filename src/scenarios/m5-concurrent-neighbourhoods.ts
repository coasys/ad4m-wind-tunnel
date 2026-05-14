/**
 * M5: Concurrent Neighbourhoods
 * Uses the executor from runner + starts 2 additional executors (3 total).
 * Each executor creates 3 perspectives, all write concurrently.
 * Measures write latency under multi-perspective load, RSS growth,
 * and cross-executor interference (resource contention).
 */

import { execSync } from "child_process";
import { join } from "path";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { startExecutor, waitForHealth, stopExecutor, sleep, ExecutorConfig } from "../executor.js";
import { InstrumentedClient } from "../client.js";

const PERSPECTIVES_PER_EXECUTOR = 3;

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

export const m5ConcurrentNeighbourhoods: Scenario = {
  id: "m5",
  name: "Concurrent Neighbourhoods",
  description: "3 executors × 3 perspectives, concurrent writes — measure interference and RSS growth",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    const branchDirName = branch.replace(/\//g, "-");
    const binaryPath = join(ctx.tmpDirBase, `ad4m-build-${branchDirName}`, "target", "release", "ad4m-executor");

    // Executor 1 is already running from the runner (port from ctx)
    // Start 2 additional executors
    const port2 = port + 1;
    const port3 = port + 2;
    const ports = [port, port2, port3];

    const extraProcs: any[] = [];
    const allClients: InstrumentedClient[] = [];

    try {
      // Client for executor 1 (already running)
      allClients.push(client);

      // Start executor 2
      console.log(`[m5] Starting executor 2 on port ${port2}...`);
      const config2: ExecutorConfig = {
        branch, port: port2,
        dataPath: join(ctx.tmpDirBase, `ad4m-wt-m5-e1`),
        adminToken: ctx.adminToken,
        adamRepoPath: ctx.adamRepoPath,
        buildDir: join(ctx.tmpDirBase, `ad4m-build-${branchDirName}`),
      };
      const proc2 = await startExecutor(binaryPath, config2);
      extraProcs.push(proc2);
      await waitForHealth(port2, 120000, ctx.adminToken);
      console.log(`[m5] Executor 2 healthy`);

      // Start executor 3
      console.log(`[m5] Starting executor 3 on port ${port3}...`);
      const config3: ExecutorConfig = {
        branch, port: port3,
        dataPath: join(ctx.tmpDirBase, `ad4m-wt-m5-e2`),
        adminToken: ctx.adminToken,
        adamRepoPath: ctx.adamRepoPath,
        buildDir: join(ctx.tmpDirBase, `ad4m-build-${branchDirName}`),
      };
      const proc3 = await startExecutor(binaryPath, config3);
      extraProcs.push(proc3);
      await waitForHealth(port3, 120000, ctx.adminToken);
      console.log(`[m5] Executor 3 healthy`);

      // Create clients for executors 2 and 3
      const client2 = new InstrumentedClient({ port: port2, adminToken: ctx.adminToken });
      const client3 = new InstrumentedClient({ port: port3, adminToken: ctx.adminToken });
      await client2.connect();
      await client3.connect();
      allClients.push(client2, client3);

      // Setup: generate agents + create perspectives
      const perspectiveUuids: string[][] = [];

      for (let e = 0; e < 3; e++) {
        const c = allClients[e];
        await c.generateAgent(`m5-executor-${e}`);

        const uuids: string[] = [];
        for (let p = 0; p < PERSPECTIVES_PER_EXECUTOR; p++) {
          const perspective = await c.createPerspective(`m5-e${e}-p${p}`);
          const uuid = perspective.data?.uuid || perspective.data?.id;
          if (!uuid) throw new Error(`Failed to create perspective e${e}-p${p}: ${perspective.error}`);
          uuids.push(uuid);
        }
        perspectiveUuids.push(uuids);
      }

      console.log(`[m5] Created ${3 * PERSPECTIVES_PER_EXECUTOR} perspectives across 3 executors`);

      // Measure initial RSS
      const initialRss = ports.map(getExecutorPid).map(getRssKb);
      console.log(`[m5] Initial RSS: ${initialRss.map(r => `${(r/1024).toFixed(0)}MB`).join(", ")}`);

      // Phase 1: Single-perspective baseline per executor (10s)
      console.log("[m5] Phase 1: Single-perspective baseline (10s)...");
      const singlePerspLatencies: number[][] = [[], [], []];
      const singleDuration = 10000;
      const singleStart = performance.now();

      await Promise.all(allClients.map(async (c, e) => {
        const start = performance.now();
        while (performance.now() - start < singleDuration) {
          const idx = singlePerspLatencies[e].length;
          const result = await c.addLink(
            perspectiveUuids[e][0],
            `ad4m://m5-single-${idx % 50}`,
            "flux://has_message",
            `literal://m5-single-${e}-${idx}`
          );
          singlePerspLatencies[e].push(result.durationMs);
          const elapsed = performance.now() - start;
          if (singlePerspLatencies[e].length > Math.floor(elapsed / 100)) await sleep(5);
        }
      }));

      const singleStats = singlePerspLatencies.map(computeStats);
      console.log(`[m5] Single-persp: ${singleStats.map((s, i) => `E${i+1}=${s.avg.toFixed(1)}ms`).join(", ")}`);

      samples.push({
        name: "phase1_single_perspective",
        durationMs: performance.now() - singleStart,
        timestamp: Date.now(),
      });

      // Phase 2: Multi-perspective writes (each executor writes across all 3 of its perspectives)
      console.log("[m5] Phase 2: Multi-perspective concurrent writes (20s)...");
      const multiPerspLatencies: number[][] = [[], [], []];
      const multiDuration = 20000;
      const multiStart = performance.now();

      await Promise.all(allClients.map(async (c, e) => {
        const start = performance.now();
        let perspIdx = 0;
        while (performance.now() - start < multiDuration) {
          const currentPersp = perspectiveUuids[e][perspIdx % PERSPECTIVES_PER_EXECUTOR];
          const idx = multiPerspLatencies[e].length;
          const result = await c.addLink(
            currentPersp,
            `ad4m://m5-multi-${idx % 50}`,
            "flux://has_message",
            `literal://m5-multi-${e}-${idx}`
          );
          multiPerspLatencies[e].push(result.durationMs);
          perspIdx++;
          const elapsed = performance.now() - start;
          if (multiPerspLatencies[e].length > Math.floor(elapsed / 100)) await sleep(5);
        }
      }));

      const multiStats = multiPerspLatencies.map(computeStats);
      console.log(`[m5] Multi-persp: ${multiStats.map((s, i) => `E${i+1}=${s.avg.toFixed(1)}ms`).join(", ")}`);

      samples.push({
        name: "phase2_multi_perspective",
        durationMs: performance.now() - multiStart,
        timestamp: Date.now(),
      });

      // Phase 3: Full concurrent pressure (15s)
      console.log("[m5] Phase 3: Full concurrent pressure (15s)...");
      const pressureLatencies: number[][] = [[], [], []];
      const pressureDuration = 15000;
      const pressureStart = performance.now();

      await Promise.all(allClients.map(async (c, e) => {
        const start = performance.now();
        let perspIdx = 0;
        while (performance.now() - start < pressureDuration) {
          const currentPersp = perspectiveUuids[e][perspIdx % PERSPECTIVES_PER_EXECUTOR];
          const idx = pressureLatencies[e].length;
          const result = await c.addLink(
            currentPersp,
            `ad4m://m5-pressure-${idx % 100}`,
            "flux://has_message",
            `literal://m5-pressure-${e}-${idx}`
          );
          pressureLatencies[e].push(result.durationMs);
          perspIdx++;
        }
      }));

      const pressureStats = pressureLatencies.map(computeStats);
      console.log(`[m5] Pressure: ${pressureStats.map((s, i) => `E${i+1}=${s.avg.toFixed(1)}ms`).join(", ")}`);

      samples.push({
        name: "phase3_pressure",
        durationMs: performance.now() - pressureStart,
        timestamp: Date.now(),
      });

      // Final RSS
      const finalRss = ports.map(getExecutorPid).map(getRssKb);
      console.log(`[m5] Final RSS: ${finalRss.map(r => `${(r/1024).toFixed(0)}MB`).join(", ")}`);

      // Query performance
      console.log("[m5] Measuring query performance...");
      const queryLatencies: number[] = [];
      for (let e = 0; e < 3; e++) {
        for (let p = 0; p < PERSPECTIVES_PER_EXECUTOR; p++) {
          const result = await allClients[e].queryLinks(perspectiveUuids[e][p], {});
          queryLatencies.push(result.durationMs);
        }
      }
      const queryStats = computeStats(queryLatencies);

      // Cleanup extra clients (don't disconnect client from ctx)
      await client2.disconnect();
      await client3.disconnect();

      const endTime = Date.now();
      const totalMs = endTime - startTime;

      // Interference metrics
      const avgSingle = singleStats.reduce((sum, s) => sum + s.avg, 0) / 3;
      const avgMulti = multiStats.reduce((sum, s) => sum + s.avg, 0) / 3;
      const avgPressure = pressureStats.reduce((sum, s) => sum + s.avg, 0) / 3;
      const multiVsSingleFactor = avgSingle > 0 ? Math.round((avgMulti / avgSingle) * 100) / 100 : 1;
      const pressureVsSingleFactor = avgSingle > 0 ? Math.round((avgPressure / avgSingle) * 100) / 100 : 1;

      const rssGrowthPerPerspective = initialRss.map((init, i) => {
        return Math.round((finalRss[i] - init) / PERSPECTIVES_PER_EXECUTOR);
      });

      const metrics = {
        mode: "multi_perspective_isolation_test",
        note: "Neighbourhood sync not available; measuring multi-executor/multi-perspective resource contention",
        executorCount: 3,
        perspectivesPerExecutor: PERSPECTIVES_PER_EXECUTOR,
        singlePerspective: {
          perExecutor: singleStats.map((s, i) => ({ executor: i + 1, links: singlePerspLatencies[i].length, ...s })),
          avgAcrossExecutors: Math.round(avgSingle * 100) / 100,
        },
        multiPerspective: {
          perExecutor: multiStats.map((s, i) => ({ executor: i + 1, links: multiPerspLatencies[i].length, ...s })),
          avgAcrossExecutors: Math.round(avgMulti * 100) / 100,
          vsBaseline: multiVsSingleFactor,
        },
        fullPressure: {
          perExecutor: pressureStats.map((s, i) => ({ executor: i + 1, links: pressureLatencies[i].length, ...s })),
          avgAcrossExecutors: Math.round(avgPressure * 100) / 100,
          vsBaseline: pressureVsSingleFactor,
        },
        queryPerformance: queryStats,
        rss: {
          initialKb: initialRss,
          finalKb: finalRss,
          growthPerPerspectiveKb: rssGrowthPerPerspective,
        },
        totalLinksWritten: [...singlePerspLatencies, ...multiPerspLatencies, ...pressureLatencies].reduce((sum, arr) => sum + arr.length, 0),
      };

      return {
        scenario: "m5-concurrent-neighbourhoods",
        branch,
        startTime,
        endTime,
        durationMs: totalMs,
        metrics,
        samples,
        summary: `3 executors × 3 perspectives: single=${avgSingle.toFixed(1)}ms, multi=${avgMulti.toFixed(1)}ms (${multiVsSingleFactor}x), pressure=${avgPressure.toFixed(1)}ms (${pressureVsSingleFactor}x). RSS growth: ${rssGrowthPerPerspective.map(r => `${(r/1024).toFixed(0)}MB/persp`).join(", ")}`,
      };

    } catch (err: any) {
      return {
        scenario: "m5-concurrent-neighbourhoods",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: err.message },
        samples,
        summary: `M5 FAILED: ${err.message}`,
      };
    } finally {
      for (const proc of extraProcs) {
        if (proc) stopExecutor(proc);
      }
      // Don't disconnect the ctx client — runner handles that
      await sleep(3000);
      try { execSync(`rm -rf "${join(ctx.tmpDirBase, 'ad4m-wt-m5-e1')}" "${join(ctx.tmpDirBase, 'ad4m-wt-m5-e2')}"`, { stdio: "pipe" }); } catch {}
    }
  },
};

/**
 * M2: Multi-Executor Scale (Baseline)
 * Start 3 executors on different ports, each with its own data dir.
 * Each does independent link operations. Measure whether multiple executors
 * on the same machine interfere with each other.
 *
 * NOTE: The main runner only starts 1 (or 2 for M1) executors.
 * M2 manages its own additional executors internally.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { InstrumentedClient } from "../client.js";
import { startExecutor, waitForHealth, stopExecutor, sleep, ExecutorConfig } from "../executor.js";
import { existsSync } from "fs";
import { join } from "path";
import { ChildProcess } from "child_process";

const EXECUTOR_COUNT = 3;
const LINKS_PER_EXECUTOR = 100;
const BASE_PORT_OFFSET = 50; // Use ports offset from the main executor

export const m2MultiExecutorScale: Scenario = {
  id: "m2",
  name: "Multi-Executor Scale",
  description: "3 executors on different ports doing independent work, measure interference",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // First, measure single-executor baseline using the already-running executor
    await client.generateAgent("wind-tunnel-multi-exec-baseline");
    const basePerspective = await client.createPerspective("multi-exec-baseline");
    if (basePerspective.error) {
      return {
        scenario: "m2-multi-executor-scale",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: basePerspective.error },
        samples,
        summary: `M2 FAILED: ${basePerspective.error}`,
      };
    }

    const baseUuid = basePerspective.data?.uuid || basePerspective.data?.id;

    // Single-executor baseline
    const singleLatencies: number[] = [];
    for (let i = 0; i < LINKS_PER_EXECUTOR; i++) {
      const r = await client.addLink(baseUuid, "ad4m://multi", "ad4m://has", `literal://single-${i}`);
      singleLatencies.push(r.durationMs);
    }

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const p95 = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)];
    };

    const singleAvg = avg(singleLatencies);
    const singleP95 = p95(singleLatencies);

    samples.push({
      name: "single_executor_baseline",
      durationMs: singleLatencies.reduce((a, b) => a + b, 0),
      timestamp: Date.now(),
    });

    // Now start additional executors and run concurrent workloads
    // Determine binary path from the build dir
    const branchDirName = branch.replace(/\//g, "-");
    const binaryPath = join(ctx.tmpDirBase, `ad4m-build-${branchDirName}`, "target", "release", "ad4m-executor");

    if (!existsSync(binaryPath)) {
      return {
        scenario: "m2-multi-executor-scale",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: {
          singleExecutor: { avgMs: singleAvg, p95Ms: singleP95, count: LINKS_PER_EXECUTOR },
          error: "Binary not found for multi-executor test",
        },
        samples,
        summary: `M2 PARTIAL: Single executor baseline only (avg ${singleAvg.toFixed(1)}ms). Multi-executor binary not found.`,
      };
    }

    // Start additional executors (we already have one on `port`)
    const additionalProcs: ChildProcess[] = [];
    const additionalClients: InstrumentedClient[] = [];
    const additionalPorts: number[] = [];

    for (let i = 1; i < EXECUTOR_COUNT; i++) {
      const execPort = port + BASE_PORT_OFFSET + i;
      const dataPath = join(ctx.tmpDirBase, `ad4m-wt-data-m2-exec-${i}`);
      const config: ExecutorConfig = {
        branch,
        port: execPort,
        dataPath,
        adminToken: ctx.adminToken,
        adamRepoPath: ctx.adamRepoPath,
        buildDir: join(ctx.tmpDirBase, `ad4m-build-${branchDirName}`),
      };

      try {
        const proc = await startExecutor(binaryPath, config);
        await waitForHealth(execPort, 120000, ctx.adminToken);
        additionalProcs.push(proc);
        additionalPorts.push(execPort);

        const c = new InstrumentedClient({ port: execPort, adminToken: ctx.adminToken });
        await c.connect();
        additionalClients.push(c);
      } catch (err: any) {
        console.log(`[m2] Failed to start executor ${i}: ${err.message}`);
      }
    }

    // Run concurrent workloads on all executors
    const multiExecResults: { executorIdx: number; avgMs: number; p95Ms: number; errors: number }[] = [];

    // Include the main executor
    const allClients = [client, ...additionalClients];

    const workPromises = allClients.map(async (c, idx) => {
      // Generate agent and create perspective on each
      if (idx > 0) {
        await c.generateAgent(`wind-tunnel-multi-exec-${idx}`);
      }
      const persp = await c.createPerspective(`multi-exec-${idx}`);
      if (persp.error) return { executorIdx: idx, avgMs: 0, p95Ms: 0, errors: LINKS_PER_EXECUTOR };

      const uuid = persp.data?.uuid || persp.data?.id;
      const latencies: number[] = [];
      let errors = 0;

      for (let i = 0; i < LINKS_PER_EXECUTOR; i++) {
        const r = await c.addLink(uuid, "ad4m://multi", "ad4m://has", `literal://multi-${idx}-${i}`);
        latencies.push(r.durationMs);
        if (r.error) errors++;
      }

      return { executorIdx: idx, avgMs: avg(latencies), p95Ms: p95(latencies), errors };
    });

    const multiResults = await Promise.all(workPromises);
    multiExecResults.push(...multiResults);

    // Cleanup additional executors
    for (const c of additionalClients) await c.disconnect();
    for (const proc of additionalProcs) stopExecutor(proc);
    await sleep(2000);

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    const multiAvg = avg(multiExecResults.map((r) => r.avgMs));
    const degradation = singleAvg > 0 ? multiAvg / singleAvg : 1;

    const metrics = {
      singleExecutor: {
        avgMs: Math.round(singleAvg * 100) / 100,
        p95Ms: Math.round(singleP95 * 100) / 100,
        count: LINKS_PER_EXECUTOR,
      },
      multiExecutor: {
        executorCount: allClients.length,
        perExecutor: multiExecResults.map((r) => ({
          executorIdx: r.executorIdx,
          avgMs: Math.round(r.avgMs * 100) / 100,
          p95Ms: Math.round(r.p95Ms * 100) / 100,
          errors: r.errors,
        })),
        overallAvgMs: Math.round(multiAvg * 100) / 100,
      },
      degradationFactor: Math.round(degradation * 100) / 100,
    };

    return {
      scenario: "m2-multi-executor-scale",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      metrics,
      samples,
      summary: `Single: avg ${singleAvg.toFixed(1)}ms. Multi (${allClients.length} executors): avg ${multiAvg.toFixed(1)}ms. Degradation: ${degradation.toFixed(2)}x`,
    };
  },
};

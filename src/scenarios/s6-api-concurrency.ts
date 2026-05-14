/**
 * S6: API Concurrency
 * Open N concurrent connections (5, 10, 25) each doing a mix of operations.
 * Measure per-connection latency and aggregate throughput.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { InstrumentedClient } from "../client.js";
import { sleep } from "../executor.js";

const CONCURRENCY_LEVELS = [5, 10, 25];
const OPS_PER_CLIENT = 20;

export const s6ApiConcurrency: Scenario = {
  id: "s6",
  name: "API Concurrency",
  description: "N concurrent connections doing mixed operations, measure latency and throughput",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Setup: generate agent and create a shared perspective
    await client.generateAgent("wind-tunnel-concurrency");
    const perspective = await client.createPerspective("concurrency-shared");
    if (perspective.error) {
      return {
        scenario: "s6-api-concurrency",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: perspective.error },
        samples,
        summary: `S6 FAILED: ${perspective.error}`,
      };
    }
    const uuid = perspective.data?.uuid || perspective.data?.id;

    // Seed some links for querying
    for (let i = 0; i < 50; i++) {
      await client.addLink(uuid, "ad4m://seed", "ad4m://has", `literal://seed-${i}`);
    }

    const levelResults: {
      concurrency: number;
      avgLatencyMs: number;
      p50Ms: number;
      p95Ms: number;
      throughputOpsPerSec: number;
      errors: number;
      totalOps: number;
    }[] = [];

    for (const concurrency of CONCURRENCY_LEVELS) {
      // Create N clients
      const clients: InstrumentedClient[] = [];
      for (let i = 0; i < concurrency; i++) {
        const c = new InstrumentedClient({
          port,
          adminToken: ctx.adminToken,
        });
        await c.connect();
        clients.push(c);
      }

      const levelStart = performance.now();

      // Each client does a mix of operations concurrently
      const clientWork = clients.map(async (c, clientIdx) => {
        const latencies: number[] = [];
        let errors = 0;

        for (let op = 0; op < OPS_PER_CLIENT; op++) {
          const opType = op % 3; // Rotate: create perspective, add link, query links
          let result: any;

          switch (opType) {
            case 0: // List/query links
              result = await c.queryLinks(uuid, { predicate: "ad4m://has" });
              break;
            case 1: // Add link
              result = await c.addLink(
                uuid,
                `ad4m://concurrent-${clientIdx}`,
                "ad4m://has",
                `literal://op-${op}`
              );
              break;
            case 2: // Create perspective
              result = await c.createPerspective(`concurrent-${concurrency}-${clientIdx}-${op}`);
              break;
          }

          latencies.push(result.durationMs);
          if (result.error) errors++;
        }

        return { latencies, errors };
      });

      const results = await Promise.all(clientWork);
      const levelDuration = performance.now() - levelStart;

      // Aggregate stats
      const allLatencies = results.flatMap((r) => r.latencies);
      const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
      const totalOps = allLatencies.length;
      const sorted = [...allLatencies].sort((a, b) => a - b);

      const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const throughput = (totalOps / levelDuration) * 1000;

      levelResults.push({
        concurrency,
        avgLatencyMs: Math.round(avg * 100) / 100,
        p50Ms: Math.round(p50 * 100) / 100,
        p95Ms: Math.round(p95 * 100) / 100,
        throughputOpsPerSec: Math.round(throughput * 10) / 10,
        errors: totalErrors,
        totalOps,
      });

      samples.push({
        name: `concurrency_${concurrency}`,
        durationMs: levelDuration,
        timestamp: Date.now(),
      });

      // Disconnect clients
      for (const c of clients) {
        await c.disconnect();
      }

      await sleep(1000);
    }

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    const metrics = {
      levels: levelResults,
      scalingFactor: levelResults.length >= 2
        ? Math.round((levelResults[levelResults.length - 1].avgLatencyMs / levelResults[0].avgLatencyMs) * 100) / 100
        : null,
    };

    const lastLevel = levelResults[levelResults.length - 1];
    return {
      scenario: "s6-api-concurrency",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      metrics,
      samples,
      summary: `Concurrency levels [${CONCURRENCY_LEVELS.join(",")}]: At ${lastLevel.concurrency} clients: avg ${lastLevel.avgLatencyMs.toFixed(1)}ms, P95 ${lastLevel.p95Ms.toFixed(1)}ms, ${lastLevel.throughputOpsPerSec.toFixed(0)} ops/s, ${lastLevel.errors} errors. Scaling factor: ${metrics.scalingFactor}x`,
    };
  },
};

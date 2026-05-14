/**
 * M1: Neighbourhood Sync Scenario
 * Two executors on the same machine, testing neighbourhood create/join/sync timing.
 * This requires two executor processes on different ports.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { InstrumentedClient } from "../client.js";
import { sleep } from "../executor.js";

export const m1NeighbourhoodSync: Scenario = {
  id: "m1",
  name: "Neighbourhood Sync",
  description: "Two executors, neighbourhood create/join/sync timing",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // M1 requires a second executor on port+1
    // The runner should have started a second executor
    const port2 = port + 1;

    const client2 = new InstrumentedClient({
      port: port2,
      adminToken: ctx.adminToken,
    });

    await client2.connect();

    // Check if second executor is healthy
    const health2 = await client2.health();
    if (health2.error) {
      return {
        scenario: "m1-neighbourhood-sync",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: `Second executor not available: ${health2.error}` },
        samples,
        summary: `M1 SKIPPED: Second executor on port ${port2} not available`,
      };
    }

    // Generate agents on both executors
    const agent1 = await client.generateAgent("wind-tunnel-sync-1");
    samples.push({ name: "agent1_generate", durationMs: agent1.durationMs, timestamp: agent1.timestamp, error: agent1.error });

    const agent2 = await client2.generateAgent("wind-tunnel-sync-2");
    samples.push({ name: "agent2_generate", durationMs: agent2.durationMs, timestamp: agent2.timestamp, error: agent2.error });

    // Create perspective on executor 1
    const perspective1 = await client.createPerspective("sync-test-neighbourhood");
    samples.push({ name: "perspective1_create", durationMs: perspective1.durationMs, timestamp: perspective1.timestamp, error: perspective1.error });

    if (perspective1.error) {
      await client2.disconnect();
      return {
        scenario: "m1-neighbourhood-sync",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: perspective1.error },
        samples,
        summary: `M1 FAILED at perspective creation: ${perspective1.error}`,
      };
    }

    const uuid1 = perspective1.data?.uuid || perspective1.data?.id;

    // Add links on executor 1
    const linkCount = 10;
    for (let i = 0; i < linkCount; i++) {
      const r = await client.addLink(uuid1, "ad4m://sync-test", "ad4m://has", `literal://sync-${i}`);
      samples.push({ name: `link_add_executor1_${i}`, durationMs: r.durationMs, timestamp: r.timestamp, error: r.error });
    }

    // Note: Full neighbourhood sync requires language installation and neighbourhood sharing
    // which is complex setup. For this iteration, we measure the perspective/link operations
    // on both executors independently as a baseline for future sync testing.

    // Create perspective on executor 2 and add links (parallel baseline)
    const perspective2 = await client2.createPerspective("sync-test-independent");
    samples.push({ name: "perspective2_create", durationMs: perspective2.durationMs, timestamp: perspective2.timestamp, error: perspective2.error });

    if (!perspective2.error) {
      const uuid2 = perspective2.data?.uuid || perspective2.data?.id;
      for (let i = 0; i < linkCount; i++) {
        const r = await client2.addLink(uuid2, "ad4m://sync-test", "ad4m://has", `literal://sync-${i}`);
        samples.push({ name: `link_add_executor2_${i}`, durationMs: r.durationMs, timestamp: r.timestamp, error: r.error });
      }
    }

    await client2.disconnect();

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    // Compare throughput between both executors
    const exec1Latencies = samples
      .filter((s) => s.name.startsWith("link_add_executor1") && !s.error)
      .map((s) => s.durationMs);
    const exec2Latencies = samples
      .filter((s) => s.name.startsWith("link_add_executor2") && !s.error)
      .map((s) => s.durationMs);

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const metrics = {
      executor1AvgLinkAddMs: Math.round(avg(exec1Latencies) * 100) / 100,
      executor2AvgLinkAddMs: Math.round(avg(exec2Latencies) * 100) / 100,
      executor1LinkCount: linkCount,
      executor2LinkCount: linkCount,
      perspectiveCreateMs: {
        executor1: perspective1.durationMs,
        executor2: perspective2.durationMs,
      },
      note: "Full neighbourhood sync requires language installation (future iteration)",
    };

    return {
      scenario: "m1-neighbourhood-sync",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      metrics,
      samples,
      summary: `Dual-executor baseline: Exec1 avg link add: ${avg(exec1Latencies).toFixed(1)}ms, Exec2: ${avg(exec2Latencies).toFixed(1)}ms. Full sync test deferred (requires language installation).`,
    };
  },
};

/**
 * S1: Cold Start Scenario (timing only)
 *
 * Measures time from executor start to first successful operations:
 * health check, agent generation, perspective creation, link add, link query.
 *
 * Correctness assertions (agent status, link presence) live in ad4m's
 * integration suite (simple.test.ts). This scenario reports timing only —
 * operation failures appear in metrics but do not gate the pass/fail verdict.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";

export const s1ColdStart: Scenario = {
  id: "s1",
  name: "Cold Start",
  description: "Measures time from executor availability to first successful operations (timing only)",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const errors: string[] = [];

    // 1. Health check
    const health = await client.health();
    samples.push({ name: "health_check", durationMs: health.durationMs, timestamp: health.timestamp, error: health.error });
    if (health.error) errors.push(`health: ${health.error}`);

    // 2. Generate agent
    const agent = await client.generateAgent("wind-tunnel-passphrase");
    samples.push({ name: "agent_generate", durationMs: agent.durationMs, timestamp: agent.timestamp, error: agent.error });
    if (agent.error) errors.push(`agent: ${agent.error}`);

    // 3. Create first perspective
    const perspective = await client.createPerspective("wind-tunnel-cold-start");
    samples.push({ name: "first_perspective_create", durationMs: perspective.durationMs, timestamp: perspective.timestamp, error: perspective.error });
    if (perspective.error) errors.push(`perspective: ${perspective.error}`);

    const uuid = perspective.data?.uuid || perspective.data?.id;

    // 4. Add first link (skip if no perspective)
    let linkMs = 0;
    let queryMs = 0;
    if (uuid) {
      const link = await client.addLink(uuid, "ad4m://cold-start-test", "ad4m://has", "literal://first-link");
      samples.push({ name: "first_link_add", durationMs: link.durationMs, timestamp: link.timestamp, error: link.error });
      linkMs = link.durationMs;
      if (link.error) errors.push(`link: ${link.error}`);

      const query = await client.queryLinks(uuid, { source: "ad4m://cold-start-test" });
      samples.push({ name: "first_link_query", durationMs: query.durationMs, timestamp: query.timestamp, error: query.error });
      queryMs = query.durationMs;
      if (query.error) errors.push(`query: ${query.error}`);
    }

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    const metrics = {
      healthMs: health.durationMs,
      agentGenerateMs: agent.durationMs,
      firstPerspectiveCreateMs: perspective.durationMs,
      firstLinkAddMs: linkMs,
      firstLinkQueryMs: queryMs,
      totalColdStartMs: totalMs,
      errors: errors.length > 0 ? errors : undefined,
    };

    const errSuffix = errors.length > 0 ? ` [${errors.length} error(s)]` : "";

    return {
      scenario: "s1-cold-start",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      passed: true,
      metrics,
      samples,
      summary: `Cold start ${totalMs}ms (health: ${health.durationMs.toFixed(0)}ms, agent: ${agent.durationMs.toFixed(0)}ms, perspective: ${perspective.durationMs.toFixed(0)}ms, link: ${linkMs.toFixed(0)}ms, query: ${queryMs.toFixed(0)}ms)${errSuffix}`,
    };
  },
};

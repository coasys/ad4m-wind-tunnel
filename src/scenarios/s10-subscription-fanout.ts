/**
 * S10: Subscription Fan-out Cost
 * Measures cost of broadcasting updates to N concurrent subscribers on a single perspective.
 * - Single executor, single perspective
 * - Subscription listeners at: 5, 10, 25, 50, 100 concurrent subscribers
 * - Write links at steady 10/s rate
 * - Measure per-subscriber notification latency, CPU scaling, memory per sub
 * - Test backpressure: add artificial delay to one subscriber, measure if it affects others
 */

import WebSocket from "ws";
import { execSync } from "child_process";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";

const SUBSCRIBER_TIERS = [5, 10, 25, 50, 100];
const WRITE_RATE_PER_SEC = 10;
const WRITE_DURATION_SEC = 10; // per tier
const BACKPRESSURE_DELAY_MS = 500;

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

interface SubscriberHandle {
  ws: WebSocket;
  notifications: { linkTimestamp: number; receivedAt: number }[];
  close: () => void;
}

async function createWSSubscriber(
  port: number,
  perspectiveUuid: string,
  adminToken: string,
  delayMs?: number
): Promise<SubscriberHandle> {
  const notifications: { linkTimestamp: number; receivedAt: number }[] = [];

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${adminToken}`);

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      // Subscribe via JSON-RPC style
      ws.send(JSON.stringify({
        id: 1,
        method: "perspective.subscribe_links",
        params: { uuid: perspectiveUuid },
      }));
      resolve();
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Subscription notifications come as events (no id field, have method field)
        if (msg.method === "perspective.link_added" || msg.params?.event === "link_added") {
          const receivedAt = performance.now();
          if (delayMs) {
            const end = performance.now() + delayMs;
            while (performance.now() < end) { /* busy wait */ }
          }
          notifications.push({
            linkTimestamp: msg.params?.link?.timestamp || msg.params?.timestamp || 0,
            receivedAt,
          });
        }
        // Also handle results without explicit event type — just look for link data
        if (msg.result === undefined && msg.id === undefined && msg.data) {
          const receivedAt = performance.now();
          if (delayMs) {
            const end = performance.now() + delayMs;
            while (performance.now() < end) { /* busy wait */ }
          }
          notifications.push({
            linkTimestamp: msg.data?.timestamp || 0,
            receivedAt,
          });
        }
      } catch {}
    });
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("WS subscription timeout")), 10000);
  });

  return {
    ws,
    notifications,
    close: () => ws.close(),
  };
}

interface TierResult {
  subscriberCount: number;
  totalWritten: number;
  avgNotificationsPerSub: number;
  avgNotificationLatencyMs: number;
  p50NotificationLatencyMs: number;
  p95NotificationLatencyMs: number;
  p99NotificationLatencyMs: number;
  rssKb: number;
  rssDeltaKb: number;
  writeAvgMs: number;
  writeP95Ms: number;
  missedNotifications: number;
  backpressure?: {
    slowSubNotifications: number;
    fastSubAvgNotifications: number;
    slowSubAvgLatencyMs: number;
    fastSubAvgLatencyMs: number;
    affectsOthers: boolean;
  };
}

export const s10SubscriptionFanout: Scenario = {
  id: "s10",
  name: "Subscription Fan-out",
  description: "Broadcast cost: N subscribers on single perspective, measure notification latency and backpressure",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Setup
    await client.generateAgent("wind-tunnel-subscription-fanout");
    const perspective = await client.createPerspective("subscription-fanout");
    if (perspective.error) {
      return {
        scenario: "s10-subscription-fanout",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: perspective.error },
        samples,
        summary: `S10 FAILED: ${perspective.error}`,
      };
    }

    const uuid = perspective.data?.uuid || perspective.data?.id;
    const adminToken = client.config.adminToken;

    // Find executor PID
    let executorPid = 0;
    try {
      const psOutput = execSync(`lsof -ti :${port} 2>/dev/null || true`).toString().trim();
      if (psOutput) executorPid = parseInt(psOutput.split("\n")[0], 10);
    } catch {}

    const baselineRss = executorPid ? getRssKb(executorPid) : 0;
    const tierResults: TierResult[] = [];

    for (const subscriberCount of SUBSCRIBER_TIERS) {
      console.log(`[s10] Testing with ${subscriberCount} subscribers...`);
      const tierStart = performance.now();

      // Create subscribers (last one gets backpressure delay at highest tier)
      const subscribers: SubscriberHandle[] = [];
      let slowSubIndex = -1;

      try {
        for (let i = 0; i < subscriberCount; i++) {
          const isLastTier = subscriberCount === SUBSCRIBER_TIERS[SUBSCRIBER_TIERS.length - 1];
          const isSlowSub = isLastTier && i === subscriberCount - 1;
          if (isSlowSub) slowSubIndex = i;

          const sub = await createWSSubscriber(
            port,
            uuid,
            adminToken,
            isSlowSub ? BACKPRESSURE_DELAY_MS : undefined
          );
          subscribers.push(sub);
        }
      } catch (err: any) {
        console.log(`[s10] Failed to create subscribers at ${subscribers.length}/${subscriberCount}: ${err.message}`);
        // Close what we opened
        for (const sub of subscribers) sub.close();
        samples.push({
          name: `tier_${subscriberCount}_failed`,
          durationMs: performance.now() - tierStart,
          timestamp: Date.now(),
          error: err.message,
        });
        continue;
      }

      // Let subscriptions settle
      await sleep(1000);

      // Record write timestamps for latency calculation
      const writeTimestamps: number[] = [];
      const writeLatencies: number[] = [];
      const totalWrites = WRITE_RATE_PER_SEC * WRITE_DURATION_SEC;
      const intervalMs = 1000 / WRITE_RATE_PER_SEC;

      // Write links at steady rate
      for (let i = 0; i < totalWrites; i++) {
        const writeStart = performance.now();
        writeTimestamps.push(writeStart);

        const result = await client.addLink(
          uuid,
          `ad4m://fanout-${subscriberCount}`,
          "ad4m://notification",
          `literal://msg-${subscriberCount}-${i}`
        );
        writeLatencies.push(result.durationMs);

        // Maintain steady rate
        const elapsed = performance.now() - writeStart;
        const waitTime = intervalMs - elapsed;
        if (waitTime > 0) await sleep(waitTime);
      }

      // Give notifications time to arrive
      await sleep(2000);

      // Measure results
      const rssNow = executorPid ? getRssKb(executorPid) : 0;

      // Calculate notification latencies
      const allLatencies: number[] = [];
      let totalNotifications = 0;

      for (let i = 0; i < subscribers.length; i++) {
        const sub = subscribers[i];
        totalNotifications += sub.notifications.length;

        // Estimate latency: notification receivedAt - writeTimestamp (matched by order)
        for (let j = 0; j < Math.min(sub.notifications.length, writeTimestamps.length); j++) {
          const latency = sub.notifications[j].receivedAt - writeTimestamps[j];
          if (latency > 0 && latency < 30000) { // sanity check
            allLatencies.push(latency);
          }
        }
      }

      const sortedLatencies = [...allLatencies].sort((a, b) => a - b);
      const sortedWriteLatencies = [...writeLatencies].sort((a, b) => a - b);
      const avgNotifications = totalNotifications / subscriberCount;

      const tierResult: TierResult = {
        subscriberCount,
        totalWritten: totalWrites,
        avgNotificationsPerSub: Math.round(avgNotifications * 10) / 10,
        avgNotificationLatencyMs: sortedLatencies.length > 0
          ? Math.round((sortedLatencies.reduce((a, b) => a + b, 0) / sortedLatencies.length) * 100) / 100
          : 0,
        p50NotificationLatencyMs: Math.round(percentile(sortedLatencies, 0.5) * 100) / 100,
        p95NotificationLatencyMs: Math.round(percentile(sortedLatencies, 0.95) * 100) / 100,
        p99NotificationLatencyMs: Math.round(percentile(sortedLatencies, 0.99) * 100) / 100,
        rssKb: rssNow,
        rssDeltaKb: rssNow - baselineRss,
        writeAvgMs: sortedWriteLatencies.length > 0
          ? Math.round((sortedWriteLatencies.reduce((a, b) => a + b, 0) / sortedWriteLatencies.length) * 100) / 100
          : 0,
        writeP95Ms: Math.round(percentile(sortedWriteLatencies, 0.95) * 100) / 100,
        missedNotifications: Math.max(0, totalWrites * subscriberCount - totalNotifications),
      };

      // Backpressure analysis (only for last tier with slow subscriber)
      if (slowSubIndex >= 0) {
        const slowSub = subscribers[slowSubIndex];
        const fastSubs = subscribers.filter((_, i) => i !== slowSubIndex);
        const fastNotifs = fastSubs.map((s) => s.notifications.length);
        const fastAvgNotifs = fastNotifs.reduce((a, b) => a + b, 0) / fastNotifs.length;

        // Get latencies for fast vs slow
        const fastLatencies: number[] = [];
        for (const sub of fastSubs) {
          for (let j = 0; j < Math.min(sub.notifications.length, writeTimestamps.length); j++) {
            const lat = sub.notifications[j].receivedAt - writeTimestamps[j];
            if (lat > 0 && lat < 30000) fastLatencies.push(lat);
          }
        }
        const slowLatencies: number[] = [];
        for (let j = 0; j < Math.min(slowSub.notifications.length, writeTimestamps.length); j++) {
          const lat = slowSub.notifications[j].receivedAt - writeTimestamps[j];
          if (lat > 0 && lat < 30000) slowLatencies.push(lat);
        }

        const fastAvgLat = fastLatencies.length > 0
          ? fastLatencies.reduce((a, b) => a + b, 0) / fastLatencies.length : 0;
        const slowAvgLat = slowLatencies.length > 0
          ? slowLatencies.reduce((a, b) => a + b, 0) / slowLatencies.length : 0;

        // Slow subscriber affects others if fast subscribers' latency is > 2x baseline
        const baselineFastLat = tierResults.length > 0
          ? tierResults[0].avgNotificationLatencyMs : fastAvgLat;
        const affectsOthers = fastAvgLat > baselineFastLat * 2;

        tierResult.backpressure = {
          slowSubNotifications: slowSub.notifications.length,
          fastSubAvgNotifications: Math.round(fastAvgNotifs * 10) / 10,
          slowSubAvgLatencyMs: Math.round(slowAvgLat * 100) / 100,
          fastSubAvgLatencyMs: Math.round(fastAvgLat * 100) / 100,
          affectsOthers,
        };
      }

      tierResults.push(tierResult);

      samples.push({
        name: `tier_${subscriberCount}`,
        durationMs: performance.now() - tierStart,
        timestamp: Date.now(),
      });

      console.log(`[s10] ${subscriberCount} subs: avgLat=${tierResult.avgNotificationLatencyMs.toFixed(1)}ms, notifs/sub=${tierResult.avgNotificationsPerSub}, writeAvg=${tierResult.writeAvgMs.toFixed(1)}ms, RSS=${(tierResult.rssKb / 1024).toFixed(0)}MB`);

      // Close all subscribers
      for (const sub of subscribers) sub.close();
      await sleep(1000);
    }

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    // Calculate scaling factor
    const firstTier = tierResults[0];
    const lastTier = tierResults[tierResults.length - 1];
    const latencyScaling = firstTier && lastTier && firstTier.avgNotificationLatencyMs > 0
      ? lastTier.avgNotificationLatencyMs / firstTier.avgNotificationLatencyMs : 0;

    const metrics = {
      tiers: tierResults,
      latencyScalingFactor: Math.round(latencyScaling * 100) / 100,
      memoryPerSubscriberKb: firstTier && lastTier
        ? Math.round((lastTier.rssDeltaKb - (firstTier.rssDeltaKb || 0)) / (lastTier.subscriberCount - firstTier.subscriberCount))
        : 0,
    };

    const summaryParts = [
      `Tested ${SUBSCRIBER_TIERS.join(",")} subscriber tiers.`,
      lastTier ? `At ${lastTier.subscriberCount} subs: avgLat=${lastTier.avgNotificationLatencyMs.toFixed(1)}ms, P95=${lastTier.p95NotificationLatencyMs.toFixed(1)}ms` : "",
      `Latency scaling: ${latencyScaling.toFixed(2)}x`,
      lastTier?.backpressure ? `Backpressure: slow sub ${lastTier.backpressure.affectsOthers ? "DOES" : "does NOT"} affect others` : "",
    ];

    return {
      scenario: "s10-subscription-fanout",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      metrics,
      samples,
      summary: summaryParts.filter(Boolean).join(" "),
    };
  },
};

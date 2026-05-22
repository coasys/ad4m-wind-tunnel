/**
 * S9: Neighbourhood Memory Leak Detection
 *
 * Targets the suspected leak in the executor under a realistic
 * Holochain-backed workload:
 *
 *   1. Generate agent + create perspective
 *   2. Apply the p-diff-sync template and publish a neighbourhood from
 *      that perspective (full Holochain DNA install + conductor binding).
 *      If publish fails (e.g. no internet to fetch the template bundle),
 *      fall back to a local perspective and flag the result so the verdict
 *      is interpreted correctly.
 *   3. Open a second WebSocket connection as a passive event subscriber,
 *      counting `link-added` events to confirm the pubsub path stays live.
 *   4. Seed 10,000 links into the perspective in batches, sampling RSS
 *      so the seed-induced growth is separated from steady-state growth.
 *   5. Monitor phase: light steady-state activity (1 link/s, 1 query/30s)
 *      with RSS sampled every 5s for several minutes.
 *   6. Fit a linear regression to the monitor-phase RSS samples to compute
 *      a slope (MB/min) and report a leak verdict.
 *
 * The seed phase deliberately drives the same pubsub broadcast path the
 * subscriber monitors — if event delivery retains references, the leak
 * will show up in monitor-phase growth even after the seed completes.
 */

import { execSync } from "child_process";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";

// Bootstrap p-diff-sync template hash — kept in lockstep with
// rust-executor/src/mainnet_seed.json#knownLinkLanguages[0]. If the
// executor's bootstrap seed changes, update this constant.
const DIFF_SYNC_TEMPLATE_HASH = "QmzSYwdbpzDfaBt28VZp5LYpy1Daq4agD7z8GTBVpJyyr3MPhTy";

const SEED_LINK_COUNT = 10_000;
const SEED_BATCH_SIZE = 250;
const MONITOR_DURATION_MS = 3 * 60 * 1000;
const MONITOR_LINK_INTERVAL_MS = 1_000;
const MONITOR_QUERY_INTERVAL_MS = 30_000;
const RSS_SAMPLE_INTERVAL_MS = 5_000;
const LEAK_THRESHOLD_MB_PER_MIN = 1; // > 1MB/min on a steady-state workload is suspicious

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
    const out = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: "utf8", timeout: 5000 }).trim();
    if (!out) return null;
    const n = parseInt(out.split("\n")[0], 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Simple least-squares slope on (x,y) points. Returns slope in y-units per x-unit. */
function linearSlope(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { x, y } of points) {
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

interface PassiveSubscriber {
  ws: WebSocket;
  linkAddedCount: number;
  errorCount: number;
  close: () => void;
}

async function openPassiveSubscriber(
  port: number,
  adminToken: string
): Promise<PassiveSubscriber> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${adminToken}`);
  const sub: PassiveSubscriber = {
    ws,
    linkAddedCount: 0,
    errorCount: 0,
    close: () => {
      try { ws.close(); } catch {}
    },
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Passive subscriber connect timeout")), 10_000);
    ws.on("open", () => { clearTimeout(timer); resolve(); });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // The /api/v1/ws endpoint multiplexes RPC responses and pubsub events.
      // Events have a top-level `type` field; RPC responses have `id`+`result`/`error`.
      if (msg.type === "link-added") sub.linkAddedCount++;
    } catch {
      sub.errorCount++;
    }
  });

  return sub;
}

export const s9NeighbourhoodMemoryLeak: Scenario = {
  id: "s9",
  name: "Neighbourhood Memory Leak",
  description: "10k-link neighbourhood perspective + active WS subscription, RSS monitored for steady-state leak",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port, adminToken } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    const executorPid = getExecutorPid(port);
    if (!executorPid) {
      return {
        scenario: "s9-neighbourhood-memory-leak",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: "Could not resolve executor PID for RSS sampling" },
        samples,
        summary: "S9 FAILED: executor PID not found",
      };
    }

    // RSS timeline samples — every entry tagged with the phase so we can
    // distinguish seed-induced growth from steady-state growth.
    type RssSample = { elapsedMs: number; rssKb: number; phase: "setup" | "seed" | "monitor" };
    const rssSamples: RssSample[] = [];
    const runStart = performance.now();
    const sampleRss = (phase: RssSample["phase"]) => {
      const rss = getRssKb(executorPid);
      if (rss !== null) {
        rssSamples.push({ elapsedMs: performance.now() - runStart, rssKb: rss, phase });
      }
    };

    sampleRss("setup");

    // ── Phase 0: agent + perspective ─────────────────────────────────
    const agent = await client.generateAgent("wind-tunnel-s9-memleak");
    samples.push({ name: "agent_generate", durationMs: agent.durationMs, timestamp: agent.timestamp, error: agent.error });

    const persp = await client.createPerspective("s9-neighbourhood-memleak");
    samples.push({ name: "perspective_create", durationMs: persp.durationMs, timestamp: persp.timestamp, error: persp.error });
    if (persp.error) {
      return {
        scenario: "s9-neighbourhood-memory-leak",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: persp.error },
        samples,
        summary: `S9 FAILED at perspective create: ${persp.error}`,
      };
    }
    const uuid = persp.data?.uuid || persp.data?.id;

    sampleRss("setup");

    // ── Phase 1: publish neighbourhood (best-effort) ─────────────────
    // Template application fetches the language bundle via the Cloudflare
    // gateway — if offline or the bundle is unavailable, we fall back to
    // a local-only perspective and mark the result accordingly. Holochain
    // DNA install on publish is the main code path we want to exercise.
    let neighbourhoodPublished = false;
    let neighbourhoodNote = "";
    let templatedLanguageAddress: string | null = null;

    console.log(`[s9] Applying p-diff-sync template (${DIFF_SYNC_TEMPLATE_HASH})...`);
    const templated = await client.applyTemplateAndPublish(
      DIFF_SYNC_TEMPLATE_HASH,
      JSON.stringify({ uid: randomUUID(), name: "wind-tunnel-s9-memleak" })
    );
    samples.push({ name: "language_apply_template", durationMs: templated.durationMs, timestamp: templated.timestamp, error: templated.error });

    if (templated.error) {
      neighbourhoodNote = `template apply failed: ${templated.error}`;
      console.log(`[s9] ${neighbourhoodNote} — falling back to local perspective`);
    } else {
      templatedLanguageAddress = templated.data?.address || templated.data?.hash || null;
      if (!templatedLanguageAddress) {
        neighbourhoodNote = "template apply returned no address";
        console.log(`[s9] ${neighbourhoodNote} — falling back to local perspective`);
      } else {
        console.log(`[s9] Templated language: ${templatedLanguageAddress}`);
        const published = await client.publishNeighbourhood(uuid, templatedLanguageAddress, { links: [] });
        samples.push({ name: "neighbourhood_publish", durationMs: published.durationMs, timestamp: published.timestamp, error: published.error });
        if (published.error) {
          neighbourhoodNote = `neighbourhood publish failed: ${published.error}`;
          console.log(`[s9] ${neighbourhoodNote} — continuing with local perspective`);
        } else {
          neighbourhoodPublished = true;
          console.log(`[s9] Neighbourhood published: ${published.data}`);
        }
      }
    }

    sampleRss("setup");

    // ── Phase 2: passive subscriber connected before seeding ─────────
    let subscriber: PassiveSubscriber | null = null;
    try {
      subscriber = await openPassiveSubscriber(port, adminToken);
      console.log(`[s9] Passive subscriber connected on a second WS`);
    } catch (err: any) {
      console.log(`[s9] Passive subscriber failed: ${err.message} — continuing without it`);
    }

    sampleRss("setup");

    // Give the conductor a moment to settle before we hammer it.
    await sleep(1000);

    // ── Phase 3: seed 10k links ──────────────────────────────────────
    console.log(`[s9] Seeding ${SEED_LINK_COUNT} links (${Math.ceil(SEED_LINK_COUNT / SEED_BATCH_SIZE)} batches of ${SEED_BATCH_SIZE})...`);
    const seedStart = performance.now();
    let seedLinkLatencies: number[] = [];
    let seedErrors = 0;
    let lastRssSampleAt = performance.now();

    for (let i = 0; i < SEED_LINK_COUNT; i++) {
      const r = await client.addLink(
        uuid,
        `ad4m://s9-seed/${i % 100}`,
        "flux://has_message",
        `literal://seed-${i}`
      );
      seedLinkLatencies.push(r.durationMs);
      if (r.error) seedErrors++;

      if ((i + 1) % SEED_BATCH_SIZE === 0) {
        const batchIdx = Math.floor(i / SEED_BATCH_SIZE);
        const recent = seedLinkLatencies.slice(-SEED_BATCH_SIZE);
        const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
        console.log(`[s9]   batch ${batchIdx + 1}/${Math.ceil(SEED_LINK_COUNT / SEED_BATCH_SIZE)}: avg=${avg.toFixed(1)}ms, total=${i + 1}`);
      }

      if (performance.now() - lastRssSampleAt >= RSS_SAMPLE_INTERVAL_MS) {
        sampleRss("seed");
        lastRssSampleAt = performance.now();
      }
    }

    const seedDurationMs = performance.now() - seedStart;
    sampleRss("seed");
    samples.push({ name: "seed_phase", durationMs: seedDurationMs, timestamp: Date.now() });
    console.log(`[s9] Seed complete: ${SEED_LINK_COUNT - seedErrors}/${SEED_LINK_COUNT} links in ${(seedDurationMs / 1000).toFixed(1)}s`);

    // Let the conductor + pubsub flush any in-flight work before we
    // start measuring steady-state growth.
    await sleep(3000);
    sampleRss("seed");

    const linksAtMonitorStart = subscriber?.linkAddedCount ?? 0;

    // ── Phase 4: monitor steady-state for several minutes ────────────
    console.log(`[s9] Monitoring RSS for ${MONITOR_DURATION_MS / 1000}s under light steady-state load...`);
    const monitorStart = performance.now();
    const monitorLinkLatencies: number[] = [];
    const monitorQueryLatencies: number[] = [];
    let monitorLinkCount = 0;
    let monitorQueryCount = 0;
    let lastLinkAt = -MONITOR_LINK_INTERVAL_MS;
    let lastQueryAt = -MONITOR_QUERY_INTERVAL_MS;
    let lastRssAt = -RSS_SAMPLE_INTERVAL_MS;

    while (performance.now() - monitorStart < MONITOR_DURATION_MS) {
      const elapsed = performance.now() - monitorStart;

      if (elapsed - lastLinkAt >= MONITOR_LINK_INTERVAL_MS) {
        lastLinkAt = elapsed;
        const r = await client.addLink(
          uuid,
          `ad4m://s9-monitor/${monitorLinkCount % 50}`,
          "flux://has_message",
          `literal://monitor-${monitorLinkCount}`
        );
        monitorLinkLatencies.push(r.durationMs);
        monitorLinkCount++;
      }

      if (elapsed - lastQueryAt >= MONITOR_QUERY_INTERVAL_MS) {
        lastQueryAt = elapsed;
        const r = await client.queryLinks(uuid, { predicate: "flux://has_message" });
        monitorQueryLatencies.push(r.durationMs);
        monitorQueryCount++;
        samples.push({ name: `monitor_query_${monitorQueryCount}`, durationMs: r.durationMs, timestamp: r.timestamp, error: r.error });
      }

      if (elapsed - lastRssAt >= RSS_SAMPLE_INTERVAL_MS) {
        lastRssAt = elapsed;
        sampleRss("monitor");
      }

      await sleep(100);
    }

    sampleRss("monitor");
    const monitorDurationMs = performance.now() - monitorStart;
    samples.push({ name: "monitor_phase", durationMs: monitorDurationMs, timestamp: Date.now() });

    const linksAtMonitorEnd = subscriber?.linkAddedCount ?? 0;
    const subscriberMonitorEvents = linksAtMonitorEnd - linksAtMonitorStart;

    // ── Teardown ─────────────────────────────────────────────────────
    subscriber?.close();

    // ── Analysis ─────────────────────────────────────────────────────
    const monitorSamples = rssSamples.filter((s) => s.phase === "monitor");
    const slopeKbPerMs = linearSlope(monitorSamples.map((s) => ({ x: s.elapsedMs, y: s.rssKb })));
    const leakRateMbPerMin = (slopeKbPerMs * 60_000) / 1024;

    let verdict: "stable" | "slow_growth" | "leaking" | "insufficient_data" = "insufficient_data";
    if (monitorSamples.length >= 4) {
      const absMb = Math.abs(leakRateMbPerMin);
      if (absMb < 0.25) verdict = "stable";
      else if (absMb < LEAK_THRESHOLD_MB_PER_MIN) verdict = "slow_growth";
      else verdict = "leaking";
    }

    const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    const p95 = (a: number[]) => {
      if (!a.length) return 0;
      const s = [...a].sort((x, y) => x - y);
      return s[Math.floor(s.length * 0.95)];
    };

    const firstSetup = rssSamples.find((s) => s.phase === "setup");
    const lastSeed = [...rssSamples].reverse().find((s) => s.phase === "seed");
    const firstMonitor = rssSamples.find((s) => s.phase === "monitor");
    const lastMonitor = [...rssSamples].reverse().find((s) => s.phase === "monitor");

    const metrics = {
      neighbourhood: {
        published: neighbourhoodPublished,
        templatedLanguageAddress,
        note: neighbourhoodNote || null,
      },
      subscriber: {
        connected: subscriber !== null,
        linkAddedEventsTotal: subscriber?.linkAddedCount ?? 0,
        linkAddedEventsDuringMonitor: subscriberMonitorEvents,
        expectedMonitorEvents: monitorLinkCount,
        deliveryRatio: monitorLinkCount > 0
          ? Math.round((subscriberMonitorEvents / monitorLinkCount) * 1000) / 1000
          : null,
      },
      seed: {
        targetLinks: SEED_LINK_COUNT,
        successful: SEED_LINK_COUNT - seedErrors,
        errors: seedErrors,
        durationMs: Math.round(seedDurationMs),
        avgLinkAddMs: Math.round(avg(seedLinkLatencies) * 100) / 100,
        p95LinkAddMs: Math.round(p95(seedLinkLatencies) * 100) / 100,
      },
      monitor: {
        durationMs: Math.round(monitorDurationMs),
        linkCount: monitorLinkCount,
        queryCount: monitorQueryCount,
        avgLinkAddMs: Math.round(avg(monitorLinkLatencies) * 100) / 100,
        p95LinkAddMs: Math.round(p95(monitorLinkLatencies) * 100) / 100,
        avgQueryMs: Math.round(avg(monitorQueryLatencies) * 100) / 100,
        p95QueryMs: Math.round(p95(monitorQueryLatencies) * 100) / 100,
      },
      rss: {
        samples: rssSamples.map((s) => ({
          elapsedMs: Math.round(s.elapsedMs),
          rssKb: s.rssKb,
          phase: s.phase,
        })),
        setupKb: firstSetup?.rssKb ?? null,
        postSeedKb: lastSeed?.rssKb ?? null,
        monitorStartKb: firstMonitor?.rssKb ?? null,
        monitorEndKb: lastMonitor?.rssKb ?? null,
        monitorSlopeKbPerMin: Math.round(slopeKbPerMs * 60_000),
        monitorLeakRateMbPerMin: Math.round(leakRateMbPerMin * 100) / 100,
        verdict,
        leakThresholdMbPerMin: LEAK_THRESHOLD_MB_PER_MIN,
      },
    };

    const endTime = Date.now();
    const summaryParts = [
      neighbourhoodPublished ? "neighbourhood=published" : `neighbourhood=local (${neighbourhoodNote})`,
      `seed=${metrics.seed.successful}/${SEED_LINK_COUNT}`,
      `monitor=${(monitorDurationMs / 1000).toFixed(0)}s, ${monitorLinkCount} links`,
      `RSS: ${firstMonitor ? (firstMonitor.rssKb / 1024).toFixed(0) : "?"}MB → ${lastMonitor ? (lastMonitor.rssKb / 1024).toFixed(0) : "?"}MB`,
      `leak=${metrics.rss.monitorLeakRateMbPerMin}MB/min (${verdict})`,
      `sub events=${subscriberMonitorEvents}/${monitorLinkCount}`,
    ];

    return {
      scenario: "s9-neighbourhood-memory-leak",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary: summaryParts.join(" | "),
    };
  },
};

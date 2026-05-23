/**
 * S9: Memory Leak Isolation
 *
 * Validates that the executor does not leak memory under sustained load,
 * and isolates *where* a leak originates by switching modes via the
 * `S9_MODE` env var:
 *
 *   - `holochain`   (default) Apply p-diff-sync template + publish
 *                   neighbourhood. Full Holochain DNA install +
 *                   conductor binding + Deno link language.
 *   - `centralized` Publish centralized-p-diff-sync.bundle.js locally,
 *                   template + publish neighbourhood. No Holochain,
 *                   but a heavy Deno link-language runtime (socket.io).
 *   - `local`       No link language, no neighbourhood. System Deno
 *                   languages (agent/perspective/neighbourhood) still
 *                   loaded.
 *   - `no-languages` Executor booted with `--language-language-only true`
 *                   (the runner threads this in from main.ts). No link
 *                   language. Only the language-language Deno isolate
 *                   exists, and it's idle for our workload.
 *
 * If `holochain` leaks and `local` doesn't → Holochain.
 * If `holochain` and `centralized` both leak but `local` doesn't → Deno
 * link-language runtime.
 * If `local` leaks but `no-languages` doesn't → one of the system Deno
 * languages.
 * If `no-languages` still leaks → Rust core executor (pubsub / link
 * store / WS handler).
 *
 * Each run cycles through three measured phases around the seed:
 *   - SETTLE  (no activity) — does RSS plateau after the seed bursts?
 *   - MONITOR (light steady load) — what's the leak rate under work?
 *   - COOLDOWN (no activity) — does RSS plateau after work stops?
 *
 * The three slopes together separate "buffered allocation that drains"
 * from "true monotonic leak". Durations are env-overrideable:
 *   S9_SETTLE_SEC (default 60), S9_MONITOR_SEC (300), S9_COOLDOWN_SEC (30)
 */

import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { resolve as resolvePath } from "path";
import { existsSync } from "fs";
import WebSocket from "ws";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";

const DIFF_SYNC_TEMPLATE_HASH = "QmzSYwdbpzDfaBt28VZp5LYpy1Daq4agD7z8GTBVpJyyr3MPhTy";

// Best-effort lookup for the centralized-p-diff-sync bundle. Override
// with S9_CENTRALIZED_BUNDLE_PATH if your AD4M checkout lives elsewhere.
function defaultCentralizedBundlePath(): string {
  const candidates = [
    process.env.S9_CENTRALIZED_BUNDLE_PATH,
    resolvePath(process.cwd(), "../ad4m/bootstrap-languages/centralized-p-diff-sync/build/bundle.js"),
    resolvePath(process.cwd(), "../../ad4m/bootstrap-languages/centralized-p-diff-sync/build/bundle.js"),
    "/Users/josh/workspaces/coasys/ad4m/bootstrap-languages/centralized-p-diff-sync/build/bundle.js",
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[candidates.length - 1] ?? "";
}

const SEED_LINK_COUNT = 10_000;
const SEED_BATCH_SIZE = 250;
const RSS_SAMPLE_INTERVAL_MS = 5_000;
const MONITOR_LINK_INTERVAL_MS = 1_000;
const MONITOR_QUERY_INTERVAL_MS = (parseInt(process.env.S9_MONITOR_QUERY_SEC || "30", 10) || 30) * 1000;
const LEAK_THRESHOLD_MB_PER_MIN = 1; // > 1 MB/min steady-state = suspicious

// Defaults trimmed from 60/300/30 to 30/180/15 so a 4-mode sweep finishes
// in ~16 min instead of ~30 min. 180s of monitor at 1 link/s + 1 query/30s
// is 6 RSS samples per quarter — enough for least-squares fit to a >1 MB/min
// threshold with low false-positive risk. For high-fidelity measurement
// (e.g. PR-gate runs), set S9_MONITOR_SEC=300 or higher.
const SETTLE_DURATION_MS = (parseInt(process.env.S9_SETTLE_SEC || "30", 10) || 30) * 1000;
const MONITOR_DURATION_MS = (parseInt(process.env.S9_MONITOR_SEC || "180", 10) || 180) * 1000;
const COOLDOWN_DURATION_MS = (parseInt(process.env.S9_COOLDOWN_SEC || "15", 10) || 15) * 1000;

type Mode = "holochain" | "centralized" | "local" | "no-languages";
type Phase = "setup" | "seed" | "settle" | "monitor" | "cooldown";

function parseMode(raw: string | undefined): Mode {
  const v = (raw || "holochain").toLowerCase();
  if (v === "centralized" || v === "local" || v === "no-languages" || v === "holochain") return v;
  // Back-compat alias: previous runs used "neighbourhood" for holochain.
  if (v === "neighbourhood") return "holochain";
  return "holochain";
}

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

/** Least-squares slope on (x,y) points; returns y-units per x-unit. */
function linearSlope(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { x, y } of points) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

function classify(absMbPerMin: number, sampleCount: number): "stable" | "slow_growth" | "leaking" | "insufficient_data" {
  if (sampleCount < 4) return "insufficient_data";
  if (absMbPerMin < 0.25) return "stable";
  if (absMbPerMin < LEAK_THRESHOLD_MB_PER_MIN) return "slow_growth";
  return "leaking";
}

interface PassiveSubscriber {
  ws: WebSocket;
  linkAddedCount: number;
  close: () => void;
}

async function openPassiveSubscriber(port: number, adminToken: string): Promise<PassiveSubscriber> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${adminToken}`);
  const sub: PassiveSubscriber = { ws, linkAddedCount: 0, close: () => { try { ws.close(); } catch {} } };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Passive subscriber connect timeout")), 10_000);
    ws.on("open", () => { clearTimeout(timer); resolve(); });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "link-added") sub.linkAddedCount++;
    } catch {}
  });
  return sub;
}

export const s9NeighbourhoodMemoryLeak: Scenario = {
  id: "s9",
  name: "Memory Leak Isolation",
  description: "Multi-mode (holochain | centralized | local | no-languages) settle/monitor/cooldown RSS regression",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port, adminToken } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const mode: Mode = parseMode(process.env.S9_MODE);

    const executorPid = getExecutorPid(port);
    if (!executorPid) {
      return {
        scenario: "s9-neighbourhood-memory-leak",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { mode, error: "Could not resolve executor PID for RSS sampling" },
        samples,
        summary: `S9[${mode}] FAILED: executor PID not found`,
      };
    }

    type RssSample = { elapsedMs: number; rssKb: number; phase: Phase };
    const rssSamples: RssSample[] = [];
    const runStart = performance.now();
    const sampleRss = (phase: Phase) => {
      const rss = getRssKb(executorPid);
      if (rss !== null) rssSamples.push({ elapsedMs: performance.now() - runStart, rssKb: rss, phase });
    };

    sampleRss("setup");

    // ── Phase 0: agent + perspective ─────────────────────────────────
    const agent = await client.generateAgent("wind-tunnel-s9-memleak");
    samples.push({ name: "agent_generate", durationMs: agent.durationMs, timestamp: agent.timestamp, error: agent.error });
    if (agent.error) console.log(`[s9] agent.generate error: ${agent.error}`);

    const persp = await client.createPerspective(`s9-${mode}`);
    samples.push({ name: "perspective_create", durationMs: persp.durationMs, timestamp: persp.timestamp, error: persp.error });
    if (persp.error) {
      return {
        scenario: "s9-neighbourhood-memory-leak",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { mode, error: persp.error },
        samples,
        summary: `S9[${mode}] FAILED at perspective create: ${persp.error}`,
      };
    }
    const uuid = persp.data?.uuid || persp.data?.id;
    sampleRss("setup");

    // ── Phase 1: link language / neighbourhood (mode-dependent) ─────
    let neighbourhoodPublished = false;
    let neighbourhoodNote = "";
    let linkLanguageAddress: string | null = null;
    let templatedLanguageAddress: string | null = null;

    if (mode === "local" || mode === "no-languages") {
      neighbourhoodNote = `skipped: S9_MODE=${mode}`;
      console.log(`[s9] ${neighbourhoodNote}`);
    } else {
      // For 'holochain' we template against the bootstrap-known p-diff-sync hash.
      // For 'centralized' we first publish the local centralized-p-diff-sync
      // bundle to get a hash, then template that.
      let sourceHash: string | null = null;

      if (mode === "centralized") {
        const bundlePath = defaultCentralizedBundlePath();
        if (!bundlePath || !existsSync(bundlePath)) {
          neighbourhoodNote = `centralized bundle not found at ${bundlePath || "<no candidates>"}`;
          console.log(`[s9] ${neighbourhoodNote} — continuing without link language`);
        } else {
          console.log(`[s9] Publishing centralized-p-diff-sync from ${bundlePath}...`);
          const published = await client.publishLanguage(bundlePath, {
            name: `centralized-p-diff-sync-${randomUUID().slice(0, 8)}`,
            description: "wind-tunnel s9 centralized link language (Deno, no Holochain)",
            possibleTemplateParams: ["uid", "name"],
          });
          samples.push({ name: "language_publish", durationMs: published.durationMs, timestamp: published.timestamp, error: published.error });
          if (published.error) {
            neighbourhoodNote = `centralized publish failed: ${published.error}`;
            console.log(`[s9] ${neighbourhoodNote} — continuing without link language`);
          } else {
            sourceHash = published.data?.address ?? null;
            console.log(`[s9] Centralized language published, hash=${sourceHash}`);
          }
        }
      } else {
        sourceHash = DIFF_SYNC_TEMPLATE_HASH;
        console.log(`[s9] Using p-diff-sync template hash ${sourceHash}`);
      }

      if (sourceHash) {
        const templated = await client.applyTemplateAndPublish(
          sourceHash,
          JSON.stringify({ uid: randomUUID(), name: `wind-tunnel-s9-${mode}` })
        );
        samples.push({ name: "language_apply_template", durationMs: templated.durationMs, timestamp: templated.timestamp, error: templated.error });
        if (templated.error) {
          neighbourhoodNote = `template apply failed: ${templated.error}`;
          console.log(`[s9] ${neighbourhoodNote} — continuing without neighbourhood`);
        } else {
          templatedLanguageAddress = templated.data?.address || templated.data?.hash || null;
          if (!templatedLanguageAddress) {
            neighbourhoodNote = "template apply returned no address";
            console.log(`[s9] ${neighbourhoodNote} — continuing without neighbourhood`);
          } else {
            console.log(`[s9] Templated language: ${templatedLanguageAddress}`);
            const pub = await client.publishNeighbourhood(uuid, templatedLanguageAddress, { links: [] });
            samples.push({ name: "neighbourhood_publish", durationMs: pub.durationMs, timestamp: pub.timestamp, error: pub.error });
            if (pub.error) {
              neighbourhoodNote = `neighbourhood publish failed: ${pub.error}`;
              console.log(`[s9] ${neighbourhoodNote} — continuing without neighbourhood`);
            } else {
              neighbourhoodPublished = true;
              linkLanguageAddress = templatedLanguageAddress;
              console.log(`[s9] Neighbourhood published: ${pub.data}`);
            }
          }
        }
      }
    }

    sampleRss("setup");

    // ── Phase 2: passive subscriber before seeding ──────────────────
    let subscriber: PassiveSubscriber | null = null;
    try {
      subscriber = await openPassiveSubscriber(port, adminToken);
      console.log(`[s9] Passive subscriber connected on a second WS`);
    } catch (err: any) {
      console.log(`[s9] Passive subscriber failed: ${err.message} — continuing without it`);
    }
    sampleRss("setup");
    await sleep(1000);

    // ── Phase 3: seed 10k links ─────────────────────────────────────
    console.log(`[s9] Seeding ${SEED_LINK_COUNT} links (${Math.ceil(SEED_LINK_COUNT / SEED_BATCH_SIZE)} batches of ${SEED_BATCH_SIZE})...`);
    const seedStart = performance.now();
    const seedLinkLatencies: number[] = [];
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
        const recent = seedLinkLatencies.slice(-SEED_BATCH_SIZE);
        const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const batchIdx = Math.floor(i / SEED_BATCH_SIZE);
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

    // ── Phase 4: settle (no activity) ───────────────────────────────
    console.log(`[s9] Settle phase: ${SETTLE_DURATION_MS / 1000}s of idle...`);
    const subEventsBeforeSettle = subscriber?.linkAddedCount ?? 0;
    const settleStart = performance.now();
    while (performance.now() - settleStart < SETTLE_DURATION_MS) {
      sampleRss("settle");
      await sleep(RSS_SAMPLE_INTERVAL_MS);
    }
    sampleRss("settle");

    // ── Phase 5: monitor (light steady-state load) ──────────────────
    console.log(`[s9] Monitor phase: ${MONITOR_DURATION_MS / 1000}s under light load...`);
    const subEventsBeforeMonitor = subscriber?.linkAddedCount ?? 0;
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
        const r = await client.addLink(uuid, `ad4m://s9-monitor/${monitorLinkCount % 50}`, "flux://has_message", `literal://monitor-${monitorLinkCount}`);
        monitorLinkLatencies.push(r.durationMs);
        monitorLinkCount++;
      }
      if (elapsed - lastQueryAt >= MONITOR_QUERY_INTERVAL_MS) {
        lastQueryAt = elapsed;
        const r = await client.queryLinks(uuid, { predicate: "flux://has_message" });
        monitorQueryLatencies.push(r.durationMs);
        monitorQueryCount++;
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

    const subEventsAfterMonitor = subscriber?.linkAddedCount ?? 0;

    // ── Phase 6: cooldown (no activity) ─────────────────────────────
    console.log(`[s9] Cooldown phase: ${COOLDOWN_DURATION_MS / 1000}s of idle...`);
    const cooldownStart = performance.now();
    while (performance.now() - cooldownStart < COOLDOWN_DURATION_MS) {
      sampleRss("cooldown");
      await sleep(RSS_SAMPLE_INTERVAL_MS);
    }
    sampleRss("cooldown");

    subscriber?.close();

    // ── Analysis: separate slopes per phase ─────────────────────────
    const phaseSamples = (p: Phase) => rssSamples.filter((s) => s.phase === p);
    const slopeFor = (p: Phase) => {
      const ss = phaseSamples(p);
      if (ss.length < 2) return { slopeKbPerMin: 0, mbPerMin: 0, samples: ss.length, verdict: classify(0, ss.length) };
      const slopeKbPerMs = linearSlope(ss.map((s) => ({ x: s.elapsedMs, y: s.rssKb })));
      const kbPerMin = slopeKbPerMs * 60_000;
      const mbPerMin = kbPerMin / 1024;
      return {
        slopeKbPerMin: Math.round(kbPerMin),
        mbPerMin: Math.round(mbPerMin * 100) / 100,
        samples: ss.length,
        verdict: classify(Math.abs(mbPerMin), ss.length),
      };
    };

    const settleStats = slopeFor("settle");
    const monitorStats = slopeFor("monitor");
    const cooldownStats = slopeFor("cooldown");

    const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    const p95 = (a: number[]) => {
      if (!a.length) return 0;
      const s = [...a].sort((x, y) => x - y);
      return s[Math.floor(s.length * 0.95)];
    };

    const firstSetup = rssSamples.find((s) => s.phase === "setup");
    const lastSeed = [...rssSamples].reverse().find((s) => s.phase === "seed");
    const firstSettle = rssSamples.find((s) => s.phase === "settle");
    const lastSettle = [...rssSamples].reverse().find((s) => s.phase === "settle");
    const firstMonitor = rssSamples.find((s) => s.phase === "monitor");
    const lastMonitor = [...rssSamples].reverse().find((s) => s.phase === "monitor");
    const firstCooldown = rssSamples.find((s) => s.phase === "cooldown");
    const lastCooldown = [...rssSamples].reverse().find((s) => s.phase === "cooldown");

    const metrics = {
      mode,
      neighbourhood: {
        published: neighbourhoodPublished,
        linkLanguageAddress,
        templatedLanguageAddress,
        note: neighbourhoodNote || null,
      },
      subscriber: {
        connected: subscriber !== null,
        linkAddedEventsTotal: subscriber?.linkAddedCount ?? 0,
        eventsDuringSettle: (subEventsBeforeMonitor) - (subEventsBeforeSettle),
        eventsDuringMonitor: subEventsAfterMonitor - subEventsBeforeMonitor,
        expectedMonitorEvents: monitorLinkCount,
        deliveryRatio: monitorLinkCount > 0
          ? Math.round(((subEventsAfterMonitor - subEventsBeforeMonitor) / monitorLinkCount) * 1000) / 1000
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
        samples: rssSamples.map((s) => ({ elapsedMs: Math.round(s.elapsedMs), rssKb: s.rssKb, phase: s.phase })),
        setupKb: firstSetup?.rssKb ?? null,
        postSeedKb: lastSeed?.rssKb ?? null,
        settleStartKb: firstSettle?.rssKb ?? null,
        settleEndKb: lastSettle?.rssKb ?? null,
        monitorStartKb: firstMonitor?.rssKb ?? null,
        monitorEndKb: lastMonitor?.rssKb ?? null,
        cooldownStartKb: firstCooldown?.rssKb ?? null,
        cooldownEndKb: lastCooldown?.rssKb ?? null,
        settle: settleStats,
        monitor: monitorStats,
        cooldown: cooldownStats,
        leakThresholdMbPerMin: LEAK_THRESHOLD_MB_PER_MIN,
        verdict: monitorStats.verdict,
        // Kept for back-compat with prior result files / aggregators.
        monitorSlopeKbPerMin: monitorStats.slopeKbPerMin,
        monitorLeakRateMbPerMin: monitorStats.mbPerMin,
      },
    };

    const endTime = Date.now();
    const mb = (kb: number | null | undefined) => kb != null ? (kb / 1024).toFixed(0) : "?";
    const summary = [
      `mode=${mode}`,
      neighbourhoodPublished ? "nbh=published" : `nbh=skipped (${neighbourhoodNote})`,
      `seed=${metrics.seed.successful}/${SEED_LINK_COUNT}`,
      `settle=${settleStats.mbPerMin}MB/min`,
      `monitor=${monitorStats.mbPerMin}MB/min (${monitorStats.verdict})`,
      `cooldown=${cooldownStats.mbPerMin}MB/min`,
      `RSS: setup=${mb(firstSetup?.rssKb)} seed=${mb(lastSeed?.rssKb)} monStart=${mb(firstMonitor?.rssKb)} monEnd=${mb(lastMonitor?.rssKb)} cool=${mb(lastCooldown?.rssKb)} MB`,
      `subEvents=${subEventsAfterMonitor - subEventsBeforeMonitor}/${monitorLinkCount}`,
    ].join(" | ");

    return {
      scenario: "s9-neighbourhood-memory-leak",
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

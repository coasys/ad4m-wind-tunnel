/**
 * W1: WE space RPC footprint
 *
 * How much executor traffic does the complete WE web app generate while it opens a populated space,
 * sits idle on it, and is clicked through? Measured from the browser's own WebSocket frames (CDP),
 * so it counts what WE + `@coasys/ad4m` actually put on the wire — every call, its params size,
 * response size and latency, and every pushed event.
 *
 * Flow (one fresh executor from the runner, multi-user off):
 *   1. Mint a WE capability JWT; build + serve WE web (`src/w1/we-app.ts`).
 *   2. Seed (not measured): create the space through WE's UI, then write channels / messages /
 *      replies / likes / tasks / events through WE's own packages (`src/w1/seed.ts`).
 *   3. Measure, in a new browser context (a returning user: same localStorage + IndexedDB, cold
 *      HTTP cache, unless W1_WARM=0):
 *        A  cold open  — navigation to /space/<uuid> → ready signal (DOM) → +W1_SETTLE_MS
 *        B  idle       — W1_IDLE_MS with no input
 *        C  interaction — each step (tab / channel / scroll) as its own sub-phase, then back
 *   4. Write results/<branch>/w1-we-space-rpc.{json,raw.json,md}.
 *
 * Env knobs: see README → "W1 — WE space RPC footprint".
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { config } from "../config.js";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { aggregatePhase, phaseMarkdown, socketSummary, type PhaseAggregate } from "../w1/analyze.js";
import { connectSessionStorage, mintWeJwt } from "../w1/auth.js";
import { procDelta, sampleProc, type ProcSample } from "../w1/proc-stats.js";
import { createSpaceViaUi, seedContent, type SeedResult, type SeedSize } from "../w1/seed.js";
import { startWeApp, type WeApp } from "../w1/we-app.js";
import { WsRecorder } from "../w1/ws-recorder.js";

const SCENARIO = "w1-we-space-rpc";

const envInt = (name: string, fallback: number) => {
  const v = process.env[name];
  return v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : fallback;
};
const envStr = (name: string, fallback: string) => process.env[name] || fallback;

interface W1Config {
  weRepo: string;
  sdk: "executor" | "pinned";
  sdkRepo: string;
  weMode: "preview" | "dev";
  wePort: number;
  access: "shared" | "personal";
  templateId: string;
  size: SeedSize;
  seedConcurrency: number;
  distinctBodies: number;
  seedBatch: number;
  idleMs: number;
  settleMs: number;
  stepMs: number;
  readyTimeoutMs: number;
  warm: boolean;
  steps: string[] | null;
  readyTexts: string[] | null;
  chrome: string | undefined;
  rebuild: boolean;
}

function readConfig(ctx: ScenarioContext): W1Config {
  // The SDK checkout: explicit, else the ad4m repo, else the checkout the executor binary sits in
  // (<repo>/target/release/ad4m-executor, path taken as given — `target` may be a symlink).
  const fromExecutor = ctx.executorPath ? dirname(dirname(dirname(ctx.executorPath))) : "";
  const csv = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);
  return {
    weRepo: config.weRepoPath,
    sdk: envStr("W1_SDK", "executor") === "pinned" ? "pinned" : "executor",
    sdkRepo: process.env.W1_AD4M_SDK_REPO || ctx.adamRepoPath || fromExecutor,
    weMode: envStr("W1_WE_MODE", "preview") === "dev" ? "dev" : "preview",
    wePort: envInt("W1_WE_PORT", ctx.port + 50),
    access: envStr("W1_ACCESS", "shared") === "personal" ? "personal" : "shared",
    templateId: envStr("W1_TEMPLATE", ""),
    size: {
      channels: envInt("W1_CHANNELS", 4),
      messagesPerChannel: envInt("W1_MESSAGES", 75),
      replyEvery: envInt("W1_REPLY_EVERY", 5),
      replies: envInt("W1_REPLIES", 2),
      signalEvery: envInt("W1_SIGNAL_EVERY", 3),
      tasks: envInt("W1_TASKS", 24),
      events: envInt("W1_EVENTS", 8),
    },
    // Each message's editor state is an `expression.create` (~10 s on a fresh node, and the executor
    // serialises them: at 16 in flight they pass the SDK's 30 s timeout). 6 keeps every call inside
    // it; a few hundred messages then take ~10-15 min. Containment is verified afterwards.
    seedConcurrency: envInt("W1_SEED_CONCURRENCY", 6),
    // Messages written through createBlocks with their own upload; the rest reuse those bodies in
    // batched writes (src/w1/seed.ts). 0 = every message through createBlocks (~1.4 s each).
    distinctBodies: envInt("W1_DISTINCT_BODIES", 24),
    seedBatch: envInt("W1_SEED_BATCH", 25),
    idleMs: envInt("W1_IDLE_MS", 60_000),
    settleMs: envInt("W1_SETTLE_MS", 5_000),
    stepMs: envInt("W1_STEP_MS", 5_000),
    readyTimeoutMs: envInt("W1_READY_TIMEOUT_MS", 120_000),
    warm: envStr("W1_WARM", "1") !== "0",
    steps: csv(process.env.W1_STEPS),
    readyTexts: csv(process.env.W1_READY_TEXT),
    chrome: process.env.W1_CHROME || undefined,
    rebuild: process.env.W1_WE_REBUILD === "1",
  };
}

/** The template a space opens with: the override, else the starter's (`we-seed.json`: workshop). */
function effectiveTemplate(cfg: W1Config): string {
  return cfg.templateId || "workshop";
}

/** What must be on screen for the space's main view to count as rendered. */
function readySignal(cfg: W1Config, seed: SeedResult): string[] {
  if (cfg.readyTexts) return cfg.readyTexts;
  switch (effectiveTemplate(cfg)) {
    case "discord":
      // The channel rail lists every seeded channel.
      return [seed.channelTitles[seed.channelTitles.length - 1]];
    default:
      // Workshop opens on /canvas, whose cards are the space's tasks and events.
      return seed.taskTitles.length ? [seed.taskTitles[0]] : [seed.channelTitles[0]];
  }
}

/** Interaction steps: visible text to click, or `@scroll`. */
function interactionSteps(cfg: W1Config, seed: SeedResult): string[] {
  if (cfg.steps) return cfg.steps;
  switch (effectiveTemplate(cfg)) {
    case "discord":
      // Opens on "Pick a channel": read #general, scroll back through it, visit every other
      // channel, then return.
      return [seed.channelTitles[0], "@scroll", ...seed.channelTitles.slice(1), seed.channelTitles[0]];
    default:
      return ["Kanban", "@scroll", "Calendar", "Flows", "Canvas", "@scroll"];
  }
}

async function waitForTexts(page: Page, texts: string[], timeoutMs: number): Promise<void> {
  await Promise.all(texts.map((t) => page.getByText(t, { exact: false }).first().waitFor({ state: "visible", timeout: timeoutMs })));
}

async function browserMetrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
  const pick = ["JSHeapUsedSize", "Nodes", "JSEventListeners", "ScriptDuration", "TaskDuration", "LayoutCount", "RecalcStyleCount"];
  const out: Record<string, number> = {};
  for (const m of metrics) if (pick.includes(m.name)) out[m.name] = m.name === "JSHeapUsedSize" ? Math.round(m.value / 1024 / 1024) : Math.round(m.value * 1000) / 1000;
  return out;
}

export const w1WeSpaceRpc: Scenario = {
  id: "w1",
  name: "WE Space RPC Footprint",
  description: "WE web app RPC + WebSocket use while opening, idling on and clicking through a populated space",
  multiUser: false,

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const startTime = Date.now();
    const cfg = readConfig(ctx);
    const samples: ScenarioResult["samples"] = [];
    const outDir = join(config.resultsDir, ctx.branch.replace(/\//g, "-"));
    const base = (passed: boolean, summary: string, metrics: Record<string, any>): ScenarioResult => ({
      scenario: SCENARIO,
      branch: ctx.branch,
      startTime,
      endTime: Date.now(),
      durationMs: Date.now() - startTime,
      passed,
      metrics,
      samples,
      summary,
    });

    if (!cfg.weRepo) {
      return base(true, "W1 SKIPPED: no WE checkout — pass --we-repo <path> or WE_REPO", { skipped: true });
    }

    let app: WeApp | null = null;
    let browser: Browser | null = null;
    const proc: Record<string, ProcSample | null> = { start: sampleProc(ctx.executorPid, Date.now()) };
    try {
      // ── 1. session + app ────────────────────────────────────────────────────
      const jwt = await mintWeJwt(ctx.client);
      app = await startWeApp({
        weRepo: cfg.weRepo,
        sdk: cfg.sdk,
        ad4mRepo: cfg.sdkRepo,
        mode: cfg.weMode,
        port: cfg.wePort,
        workDir: join(ctx.tmpDirBase, "ad4m-wt-w1-we"),
        rebuild: cfg.rebuild,
      });
      const storage = connectSessionStorage(app.connectVersion, ctx.port, jwt);
      browser = await chromium.launch({ headless: true, ...(cfg.chrome ? { executablePath: cfg.chrome } : {}) });
      const viewport = { width: 1440, height: 900 };

      const withSession = async (c: BrowserContext) =>
        c.addInitScript((s: Record<string, string>) => {
          // Runs in the page, before WE's own scripts: the session a returning user already has.
          const ls = (globalThis as any).localStorage;
          for (const [k, v] of Object.entries(s)) if (ls.getItem(k) !== v) ls.setItem(k, v);
        }, storage);

      // ── 2. seed (not measured) ─────────────────────────────────────────────
      const seedT0 = Date.now();
      const seedCtx = await browser.newContext({ viewport });
      await withSession(seedCtx);
      const seedPage = await seedCtx.newPage();
      await seedPage.goto(app.url);
      const spaceName = `W1 Space ${new Date().toISOString().slice(0, 16)}`;
      await createSpaceViaUi(seedPage, { spaceName, agentName: "Wind Tunnel", access: cfg.access });
      // The modal closes before the neighbourhood URL is written back; wait for it.
      let perspective: any = null;
      for (const deadline = Date.now() + 90_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 1000))) {
        const all = await ctx.client.call<any[]>("perspective.all", {});
        perspective = all.find((p) => p.name === spaceName) ?? null;
        if (perspective && (cfg.access === "personal" || perspective.sharedUrl)) break;
      }
      if (!perspective) throw new Error(`the space "${spaceName}" has no perspective after WE created it`);
      if (cfg.access === "shared" && !perspective.sharedUrl) throw new Error("WE created the space but did not publish it as a neighbourhood within 90 s");
      samples.push({ name: "seed:create-space", durationMs: Date.now() - seedT0, timestamp: seedT0 });

      const contentT0 = Date.now();
      const seed = await seedContent({
        weRepo: cfg.weRepo,
        executorUrl: `http://127.0.0.1:${ctx.port}`,
        token: jwt,
        spaceUuid: perspective.uuid,
        size: cfg.size,
        templateId: cfg.templateId,
        concurrency: cfg.seedConcurrency,
        distinctBodies: cfg.distinctBodies,
        batchSize: cfg.seedBatch,
      });
      samples.push({ name: "seed:content", durationMs: Date.now() - contentT0, timestamp: contentT0 });
      // Let WE's own tab finish reacting to the writes, so its state is what a returning user has.
      await seedPage.goto(`${app.url}/space/${perspective.uuid}`);
      await waitForTexts(seedPage, readySignal(cfg, seed), cfg.readyTimeoutMs);
      await seedPage.waitForTimeout(3000);
      const state = cfg.warm ? await seedCtx.storageState({ indexedDB: true }) : undefined;
      await seedCtx.close();
      console.log(`[w1] seeded ${seed.messages} messages, ${seed.replies} replies, ${seed.signals} likes, ${seed.tasks} tasks, ${seed.events} events in ${((Date.now() - seedT0) / 1000).toFixed(0)}s`);
      proc.seeded = sampleProc(ctx.executorPid, Date.now());

      // ── 3. measure ─────────────────────────────────────────────────────────
      const context = await browser.newContext({ viewport, ...(state ? { storageState: state } : {}) });
      await withSession(context);
      const page = await context.newPage();
      const pageSockets: string[] = [];
      page.on("websocket", (ws) => pageSockets.push(ws.url().replace(/([?&]token=)[^&]*/i, "$1<redacted>")));
      const consoleErrors: Record<string, number> = {};
      const rec = new WsRecorder(ctx.port);
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors[rec.currentPhase] = (consoleErrors[rec.currentPhase] ?? 0) + 1;
      });
      const cdp = await context.newCDPSession(page);
      await rec.attach(cdp);
      await cdp.send("Performance.enable");

      const windows: Record<string, { startMs: number; endMs: number }> = {};
      const browserAt: Record<string, Record<string, number>> = {};
      const phase = (name: string) => {
        const now = rec.nowMs();
        const prev = rec.currentPhase;
        if (windows[prev]) windows[prev].endMs = now;
        rec.setPhase(name);
        windows[name] = { startMs: now, endMs: now };
      };

      // A — cold open
      proc.A0 = sampleProc(ctx.executorPid, Date.now());
      phase("A");
      // The pointer starts at (0,0), over WE's rail, which opens on hover and covers the template's
      // own left column. Park it in the content area, where a person reading the space has it.
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      const openT0 = rec.nowMs();
      await page.goto(`${app.url}/space/${perspective.uuid}`);
      const domContentLoadedMs = rec.nowMs() - openT0;
      const readyTexts = readySignal(cfg, seed);
      await waitForTexts(page, readyTexts, cfg.readyTimeoutMs);
      const readyMs = rec.nowMs() - openT0;
      const shotsDir = join(outDir, "w1-shots");
      mkdirSync(shotsDir, { recursive: true });
      const shot = (label: string) =>
        page.screenshot({ path: join(shotsDir, `${label.replace(/[^a-z0-9._-]+/gi, "_")}.png`) }).catch(() => {});
      // WE's first focusable element (the logo) takes focus on load, and the rail opens while it holds
      // focus — over the template's own left column. Drop focus and park the pointer, as a person
      // clicking into the page would.
      const unfocus = async () => {
        await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
        await page.mouse.move(viewport.width / 2, viewport.height / 2);
      };
      await unfocus();
      await shot("A-ready");
      const callsAtReady = rec.calls.filter((c) => c.phase === "A").length;
      console.log(`[w1] A: ready after ${(readyMs / 1000).toFixed(1)}s (${callsAtReady} calls)`);
      await page.waitForTimeout(cfg.settleMs);
      browserAt.A = await browserMetrics(cdp);
      proc.A1 = sampleProc(ctx.executorPid, Date.now());

      // B — idle
      phase("B");
      await page.waitForTimeout(cfg.idleMs);
      browserAt.B = await browserMetrics(cdp);
      await shot("B-end");
      proc.B1 = sampleProc(ctx.executorPid, Date.now());
      console.log(`[w1] B: ${rec.calls.filter((c) => c.phase === "B").length} calls in ${cfg.idleMs / 1000}s idle`);

      // C — interaction, one sub-phase per step
      const steps = interactionSteps(cfg, seed);
      const stepNames: string[] = [];
      const stepUrls: Record<string, string> = {};
      for (const [i, step] of steps.entries()) {
        const name = `C${i + 1}:${step}`;
        stepNames.push(name);
        phase(name);
        if (step === "@scroll") {
          await page.mouse.move(viewport.width / 2, viewport.height / 2);
          for (let s = 0; s < 6; s++) {
            await page.mouse.wheel(0, effectiveTemplate(cfg) === "discord" ? -900 : 700);
            await page.waitForTimeout(250);
          }
        } else {
          try {
            await unfocus();
            await page.getByText(step, { exact: true }).first().click({ timeout: 15_000 });
          } catch (err) {
            await shot(`${name}-FAILED`);
            throw err;
          }
        }
        await page.waitForTimeout(cfg.stepMs);
        stepUrls[name] = page.url().replace(app.url, "");
        await shot(name);
      }
      phase("end");
      browserAt.C = await browserMetrics(cdp);
      proc.C1 = sampleProc(ctx.executorPid, Date.now());
      await context.close();

      // ── 4. aggregate + write ───────────────────────────────────────────────
      const calls = rec.calls;
      const frames = rec.frames;
      const agg: Record<string, PhaseAggregate> = {};
      for (const p of ["A", "B", ...stepNames]) agg[p] = aggregatePhase(p, windows[p], calls, frames, rec.http);
      // C overall: every step relabelled into one phase.
      const isC = (ph: string) => ph.startsWith("C");
      const cWindow = { startMs: windows[stepNames[0]].startMs, endMs: windows[stepNames[stepNames.length - 1]].endMs };
      agg.C = aggregatePhase(
        "C",
        cWindow,
        calls.filter((c) => isC(c.phase)).map((c) => ({ ...c, phase: "C" })),
        frames.filter((f) => isC(f.phase)).map((f) => ({ ...f, phase: "C" })),
        rec.http.filter((h) => isC(h.phase)).map((h) => ({ ...h, phase: "C" })),
      );
      // A split at the ready signal.
      const aCalls = calls.filter((c) => c.phase === "A");
      const aReadyWindow = { startMs: windows.A.startMs, endMs: windows.A.startMs + readyMs };
      agg["A:to-ready"] = aggregatePhase(
        "A:to-ready",
        aReadyWindow,
        aCalls.filter((c) => c.sentAt <= openT0 + readyMs).map((c) => ({ ...c, phase: "A:to-ready" })),
        frames.filter((f) => f.phase === "A" && f.t <= openT0 + readyMs).map((f) => ({ ...f, phase: "A:to-ready" })),
        rec.http.filter((h) => h.phase === "A" && h.t <= openT0 + readyMs).map((h) => ({ ...h, phase: "A:to-ready" })),
      );
      const sockets = socketSummary([...rec.sockets.values()]);

      const totals = {
        calls: calls.length,
        framesSent: frames.filter((f) => f.dir === "sent").length,
        framesRecv: frames.filter((f) => f.dir === "recv").length,
        bytesSent: frames.filter((f) => f.dir === "sent").reduce((a, f) => a + f.bytes, 0),
        bytesRecv: frames.filter((f) => f.dir === "recv").reduce((a, f) => a + f.bytes, 0),
        unparsedFrames: rec.unparsed,
        unanswered: rec.unanswered.length,
      };
      const executor = {
        beforeSeed: proc.start,
        afterSeed: proc.seeded,
        A: procDelta(proc.A0, proc.A1),
        B: procDelta(proc.A1, proc.B1),
        C: procDelta(proc.B1, proc.C1),
      };
      const run = {
        weCommit: app.weCommit,
        weMode: cfg.weMode,
        weBuildMs: app.buildMs,
        sdk: cfg.sdk,
        sdkVersion: app.sdkVersion,
        sdkSource: app.sdkSource,
        connectVersion: app.connectVersion,
        executorPath: ctx.executorPath,
        template: effectiveTemplate(cfg),
        access: cfg.access,
        warm: cfg.warm,
        size: cfg.size,
        idleMs: cfg.idleMs,
        settleMs: cfg.settleMs,
        stepMs: cfg.stepMs,
        readyTexts,
        steps,
        browser: browser.version(),
      };

      const md: string[] = [];
      md.push(`# W1 — WE space RPC footprint (${ctx.branch})`);
      md.push("");
      md.push(
        `WE \`${run.weCommit}\` (${run.weMode} build, SDK ${run.sdkVersion} from ${run.sdk === "executor" ? "the executor's ad4m checkout" : "WE's pin"}) · ` +
          `template \`${run.template}\` · ${run.access} space · ${seed.channelIds.length} channels × ${cfg.size.messagesPerChannel} messages ` +
          `(${seed.messages} messages, ${seed.replies} replies, ${seed.signals} likes) · ${seed.tasks} tasks · ${seed.events} events · Chromium ${run.browser} headless`,
      );
      md.push("");
      md.push(
        `**Open:** ready (\`${readyTexts.join("`, `")}\` visible) after **${(readyMs / 1000).toFixed(2)} s** and **${callsAtReady} RPC calls**; ` +
          `DOMContentLoaded ${(domContentLoadedMs / 1000).toFixed(2)} s.`,
      );
      md.push(
        `**Sockets:** ${sockets.executorSockets} to the executor (${sockets.reconnects} reconnects), ${sockets.otherSockets} other; ` +
          `page saw ${pageSockets.length}. **Totals:** ${totals.calls} calls, sent ${totals.framesSent} frames / ${(totals.bytesSent / 1024).toFixed(1)} KB, ` +
          `received ${totals.framesRecv} frames / ${(totals.bytesRecv / 1024).toFixed(1)} KB.`,
      );
      const fmtProc = (d: ReturnType<typeof procDelta>) => (d ? `${d.cpuSec} CPU-s (${d.cpuCores} cores), RSS ${d.rssStartMb}→${d.rssEndMb} MB` : "n/a");
      md.push(`**Executor:** A ${fmtProc(executor.A)} · B ${fmtProc(executor.B)} · C ${fmtProc(executor.C)}.`);
      md.push(
        `**Browser (cumulative at phase end):** ` +
          ["A", "B", "C"].map((p) => `${p}: heap ${browserAt[p].JSHeapUsedSize} MB, script ${browserAt[p].ScriptDuration} s, nodes ${browserAt[p].Nodes}`).join(" · "),
      );
      md.push("");
      md.push("## Phase A — cold open");
      md.push("");
      md.push(phaseMarkdown(`A to ready (${(readyMs / 1000).toFixed(1)} s)`, agg["A:to-ready"], { duplicates: 0 }));
      md.push(phaseMarkdown(`A whole (to ready + ${cfg.settleMs / 1000} s settle)`, agg.A));
      md.push("## Phase B — idle");
      md.push("");
      md.push(phaseMarkdown(`B idle (${cfg.idleMs / 1000} s)`, agg.B));
      md.push(`Calls per second: ${agg.B.callsPerSecond.join(" ")}`);
      md.push("");
      md.push("## Phase C — interaction");
      md.push("");
      md.push("| Step | URL after | Calls | Repeats | Sent | Received | Events | Top methods |");
      md.push("|---|---|---:|---:|---:|---:|---:|---|");
      for (const s of stepNames) {
        const a = agg[s];
        md.push(
          `| ${s} | \`${decodeURIComponent(stepUrls[s] ?? "").replace(perspective.uuid, "<space>")}\` | ${a.calls} | ${a.duplicateCalls} | ${(a.bytesSent / 1024).toFixed(1)} KB | ${(a.bytesRecv / 1024).toFixed(1)} KB | ${a.events} | ` +
            a.methods.slice(0, 4).map((m) => `\`${m.method}\` ${m.count}`).join(", ") +
            " |",
        );
      }
      md.push("");
      md.push(phaseMarkdown("C all steps", agg.C));
      if (Object.keys(consoleErrors).length) md.push(`Console errors by phase: ${JSON.stringify(consoleErrors)}`);
      md.push("");

      mkdirSync(outDir, { recursive: true });
      const raw = {
        run,
        seed,
        windows,
        sockets: [...rec.sockets.values()].map((s) => ({ ...s, url: s.safeUrl })),
        pageSockets,
        http: rec.http,
        calls,
        frames,
        executor,
        browserAt,
        consoleErrors,
        stepUrls,
      };
      writeFileSync(join(outDir, `${SCENARIO}.raw.json`), JSON.stringify(raw));
      writeFileSync(join(outDir, `${SCENARIO}.md`), md.join("\n"));
      console.log(`[w1] wrote ${join(outDir, `${SCENARIO}.md`)} and .raw.json`);

      const flat = {
        readyMs: Math.round(readyMs),
        A_callsToReady: callsAtReady,
        A_calls: agg.A.calls,
        A_duplicateCalls: agg.A.duplicateCalls,
        A_bytesRecv: agg.A.bytesRecv,
        B_calls: agg.B.calls,
        B_callsPerSec: agg.B.callsPerSec,
        B_events: agg.B.events,
        C_calls: agg.C.calls,
        C_duplicateCalls: agg.C.duplicateCalls,
        executorSockets: sockets.executorSockets,
        reconnects: sockets.reconnects,
        totalCalls: totals.calls,
      };
      const passed = totals.unanswered === 0 || totals.unanswered < totals.calls * 0.01;
      return base(
        passed,
        `open ${(readyMs / 1000).toFixed(1)}s / ${callsAtReady} calls to ready (${agg.A.calls} in A, ${agg.A.duplicateCalls} repeats); ` +
          `idle ${agg.B.callsPerSec}/s; interaction ${agg.C.calls} calls over ${stepNames.length} steps; ${sockets.executorSockets} socket(s)`,
        { ...flat, run, seed: { ...seed, channelIds: undefined }, totals, sockets, executor, browserAt, phases: agg },
      );
    } catch (err: any) {
      return base(false, `W1 FAILED: ${err.message}`, { error: err.message, stack: String(err.stack ?? "").slice(0, 2000) });
    } finally {
      await browser?.close().catch(() => {});
      await app?.stop().catch(() => {});
    }
  },
};

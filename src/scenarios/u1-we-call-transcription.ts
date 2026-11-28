/**
 * U1: WE Call + Transcription — the RPC traffic of one real session.
 *
 * Runs WE's web app from its checkout against the runner's executor, in Chrome, with the
 * ad4m-devtools bridge injected the way its extension injects it. As a new user it creates a shared
 * space, opens the Workshop template, starts a call and transcribes it: Chrome's fake microphone
 * plays a recorded sentence on a loop, WE's worklet cuts utterances, and the executor's Whisper
 * model transcribes them. Every executor request is recorded with its JS stack.
 *
 * Output: `results/<branch>/u1/rpc-report.md` — redundant calls (same call, same answer; identical
 * calls in flight; polling; N+1 fan-out; duplicate writes and subscriptions), expensive calls
 * (slowest, heaviest, largest) and push-event volume, each attributed to WE source lines — plus
 * `rpc-calls.json` with the raw data and a screenshot per step.
 *
 * Passes when every step completes, the transcript contains the spoken sentence, WE shows it, and
 * the bridge's request count matches the wire's.
 */

import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { prepareSpeechWav } from "../we/audio.js";
import { CallSiteResolver } from "../we/callsites.js";
import { devtoolsScript, RpcCollector, sessionScript, TAP_SCRIPT } from "../we/devtools.js";
import { resolveWeEnv } from "../we/env.js";
import { analyse, phaseOf, wordCoverage, type Phase } from "../we/rpc-analysis.js";
import { renderReport } from "../we/rpc-report.js";
import { createTestUser, installTranscriptionModel } from "../we/setup.js";
import * as ui from "../we/ui.js";
import { startWeServer, type WeServer } from "../we/we-server.js";

const SCENARIO = "u1-we-call-transcription";
const WE_PORT_OFFSET = 50;
const DISPLAY_NAME = "U1 Wind Tunnel";
const TEMPLATE = "Workshop";
const MODEL_TIMEOUT_MS = 45 * 60000;
/** Background traffic after the call ends — where polling shows itself. */
const SETTLE_MS = 15000;

const log = (msg: string) => console.log(`[u1] ${msg}`);

function gitHead(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "describe", "--always", "--dirty", "--exclude", "*"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export const u1WeCallTranscription: Scenario = {
  id: "u1",
  name: "WE Call Transcription",
  description:
    "WE in Chrome with ad4m-devtools: create a shared space, open Workshop, join a call, transcribe fake speech with Whisper; report redundant and expensive RPC calls",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const startTime = Date.now();
    const outDir = join(ctx.resultsDir, "u1");
    mkdirSync(outDir, { recursive: true });
    const result = (passed: boolean, summary: string, metrics: Record<string, any> = {}): ScenarioResult => ({
      scenario: SCENARIO,
      branch: ctx.branch,
      startTime,
      endTime: Date.now(),
      durationMs: Date.now() - startTime,
      passed,
      metrics,
      samples: steps.map((s) => ({ name: s.name, durationMs: s.ms, timestamp: s.at, error: s.ok ? undefined : s.note })),
      summary,
    });
    const steps: { name: string; ok: boolean; ms: number; at: number; note?: string }[] = [];
    const phases: Phase[] = [];

    const { env, missing } = resolveWeEnv(ctx.adamRepoPath);
    if (missing.length) return result(true, `U1 SKIPPED: ${missing.join("; ")}`, { skipped: true, missing });

    const executorUrl = `http://127.0.0.1:${ctx.port}`;
    let server: WeServer | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    let collector: RpcCollector | undefined;
    let transcriptInUi = false;
    let pressedRecord: boolean | undefined;
    let failed: string | undefined;

    const step = async <T>(name: string, fn: () => Promise<T>, recordPhase = false): Promise<T | undefined> => {
      if (failed) {
        steps.push({ name, ok: false, ms: 0, at: Date.now(), note: "not run" });
        return undefined;
      }
      const at = Date.now();
      log(`${name}...`);
      try {
        const value = await fn();
        steps.push({ name, ok: true, ms: Date.now() - at, at });
        return value;
      } catch (e: any) {
        failed = `${name}: ${e.message}`;
        steps.push({ name, ok: false, ms: Date.now() - at, at, note: e.message });
        log(`FAILED ${failed}`);
        if (page) {
          await page.screenshot({ path: join(outDir, `failed-${name}.png`) }).catch(() => {});
          writeFileSync(join(outDir, `failed-${name}.ui.txt`), await ui.describeUi(page));
        }
        return undefined;
      } finally {
        if (recordPhase) phases.push({ name, start: at, end: Date.now() });
        if (recordPhase && page && !failed) await page.screenshot({ path: join(outDir, `${phases.length}-${name}.png`) }).catch(() => {});
      }
    };

    // The operator's part: a speech model on the node, and an account for the person using WE.
    const modelId = await step("install-whisper", () =>
      installTranscriptionModel(ctx.client, env.whisperModel, MODEL_TIMEOUT_MS, log),
    );
    const user = await step("create-user", () => createTestUser(ctx.client));

    let snapshot: Awaited<ReturnType<RpcCollector["snapshot"]>> | undefined;
    let chrome = "not started";
    try {
      try {
        await step("start-we", async () => {
          server = await startWeServer(env, ctx.port + WE_PORT_OFFSET);
          const wav = prepareSpeechWav(env.ffmpeg, env.speechAudio, outDir);
          browser = await chromium.launch({
            executablePath: env.chrome,
            headless: !env.headed,
            args: [
              "--use-fake-ui-for-media-stream",
              "--use-fake-device-for-media-stream",
              `--use-file-for-fake-audio-capture=${wav}`,
              "--autoplay-policy=no-user-gesture-required",
            ],
          });
          const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
          await context.grantPermissions(["microphone", "camera"], { origin: server.url });
          await context.addInitScript(sessionScript(server.url, env.connectVersion, executorUrl, user!.token));
          await context.addInitScript(devtoolsScript(env.devtoolsRepo));
          await context.addInitScript(TAP_SCRIPT);
          page = await context.newPage();
          page.on("pageerror", (e) => log(`page error: ${e.message.split("\n")[0]}`));
          collector = new RpcCollector(page, executorUrl);
          collector.attach(context);
          collector.start();
        });

        const spaceName = `U1 Space ${new Date().toISOString().slice(11, 19)}`;
        await step(
          "boot",
          async () => {
            await page!.goto(server!.url);
            await ui.waitForShell(page!, 120000);
            await ui.setDisplayName(page!, DISPLAY_NAME);
          },
          true,
        );
        await step(
          "create-space",
          async () => {
            await ui.createSharedSpace(page!, spaceName, 300000);
            await ui.openSpace(page!, spaceName, 60000);
          },
          true,
        );
        await step("open-template", () => ui.openTemplate(page!, TEMPLATE, 60000), true);
        await step("join-call", () => ui.startCall(page!, 60000), true);
        await step(
          "transcribe",
          async () => {
            pressedRecord = (await ui.ensureTranscribing(page!, 180000)).pressed;
            await page!.waitForTimeout(env.transcribeSeconds * 1000);
            const heard = collector!.transcript();
            if (heard.length === 0) throw new Error(`nothing was transcribed in ${env.transcribeSeconds}s`);
            const sample = heard[heard.length - 1].text.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            transcriptInUi = await ui.showsText(page!, new RegExp(sample, "i"));
          },
          true,
        );
        await step(
          "leave",
          async () => {
            await ui.leaveCall(page!, 30000);
            await page!.waitForTimeout(SETTLE_MS);
          },
          true,
        );
      } finally {
        await collector?.stop().catch((e) => log(`collector stop: ${e.message}`));
      }
      // Before the dev server stops: call sites are mapped through the source maps it serves.
      if (collector && server) snapshot = await collector.snapshot(new CallSiteResolver(env.weRepo, server.url));
      if (browser) chrome = browser.version();
    } finally {
      await browser?.close().catch(() => {});
      await server?.stop();
    }

    if (!snapshot) return result(false, `FAILED ${failed}`, { steps });

    const transcript = collector!.transcript();
    const coverage = wordCoverage(env.speechText, transcript.map((l) => l.text).join(" "));
    const analysis = analyse({ calls: snapshot.calls, events: snapshot.events, phases, subscriptions: snapshot.subscriptions });
    const i = snapshot.integrity;
    const captureOk = i.devtoolsInstalled && i.tappedRequests === i.wireRequests;
    const passed = !failed && coverage >= 0.8 && transcriptInUi && captureOk;

    const report = renderReport(
      {
        analysis,
        integrity: i,
        transcript,
        expectedText: env.speechText,
        coverage,
        transcriptInUi,
        steps: steps.map((s) => ({
          ...s,
          note: s.name === "transcribe" && s.ok ? `record ${pressedRecord ? "pressed" : "started by WE on joining"}` : s.note,
        })),
        meta: {
          Branch: ctx.branch,
          Executor: ctx.executorPath ?? "runner build",
          WE: `${gitHead(env.weRepo)} (${env.weRepo})`,
          "ad4m-devtools": gitHead(env.devtoolsRepo),
          Whisper: `${env.whisperModel} (${modelId ?? "not installed"})`,
          Chrome: chrome,
          Run: new Date(startTime).toISOString(),
        },
      },
      (t) => phaseOf(t, phases),
    );
    writeFileSync(join(outDir, "rpc-report.md"), report);
    writeFileSync(
      join(outDir, "rpc-calls.json"),
      JSON.stringify({ phases, steps, integrity: i, transcript, calls: snapshot.calls, subscriptions: snapshot.subscriptions, analysis }, null, 2),
    );
    log(`Report: ${join(outDir, "rpc-report.md")}`);

    const t = analysis.totals;
    return result(
      passed,
      `${failed ? `FAILED ${failed} · ` : ""}${t.calls} calls (${t.redundantReads} redundant, ${t.coalescable} coalescable, ${analysis.polling.length} polling, ${analysis.fanOut.length} fan-out), ${t.events} push events; transcript ${Math.round(coverage * 100)}%${transcriptInUi ? "" : " (not shown in WE)"}${captureOk ? "" : " · CAPTURE INCOMPLETE"} → ${join(outDir, "rpc-report.md")}`,
      {
        calls: t.calls,
        wsCalls: t.wsCalls,
        httpCalls: t.httpCalls,
        errors: t.errors,
        requestBytes: t.requestBytes,
        responseBytes: t.responseBytes,
        pushEvents: t.events,
        pushEventBytes: t.eventBytes,
        redundantReads: t.redundantReads,
        coalescable: t.coalescable,
        identicalWrites: t.identicalWrites,
        pollingLoops: analysis.polling.length,
        fanOutBursts: analysis.fanOut.length,
        subscriptions: analysis.subscriptions.total,
        transcriptLines: transcript.length,
        transcriptCoverage: Math.round(coverage * 100) / 100,
        transcriptInUi,
        devtoolsOwnRequests: i.devtoolsOwnRequests,
        captureComplete: captureOk,
        ...Object.fromEntries(analysis.phases.map((p) => [`${p.name}Ms`, p.wallMs])),
        ...Object.fromEntries(analysis.phases.map((p) => [`${p.name}Calls`, p.calls])),
      },
    );
  },
};

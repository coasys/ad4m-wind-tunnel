/**
 * P1: Platform Idle Baseline
 *
 * What one executor with no spaces costs at rest. Boots a fresh executor
 * (Holochain on or off per `--run-holochain`), generates the agent, waits a
 * warm-up, then measures a fixed idle window with no RPC traffic.
 *
 * Records: RSS (and RssAnon/RssFile), VmSwap, thread count, threads grouped
 * by pool, CPU % of one core averaged over the window (executor + children,
 * from /proc tick deltas) split by thread pool, child processes, host busy %
 * and load average before/after the window.
 *
 * Tunables (env, defaults shown):
 *   P1_WARMUP_SEC  60    wait after agent.generate before the window
 *   P1_IDLE_SEC    300   idle window length
 *   P1_SAMPLE_SEC  5     sample period inside the window
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import {
  envInt, launchExecutor, stopOwned, ensureAgent, executorIdentity, ownedDataPath, removeDataDir,
  measureIdleWindow, idleWindowMarkdown, threadGroupsMarkdown, idleSummary, scenarioName, mb, OwnedExecutor,
} from "../platform/common.js";

const ID = "p1";
const NAME = "Platform Idle Baseline";

export const p1IdleBaseline: Scenario = {
  id: ID,
  name: NAME,
  description: "Idle cost of one executor with no spaces: RSS, swap, threads by pool, CPU over a fixed window, children",
  managesOwnEnvironment: true,

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const startTime = Date.now();
    const parameters = {
      warmupSec: envInt("P1_WARMUP_SEC", 60),
      idleSec: envInt("P1_IDLE_SEC", 300),
      sampleSec: envInt("P1_SAMPLE_SEC", 5),
      runHolochain: ctx.runHolochain ?? true,
    };
    const dataPath = ownedDataPath(ctx);
    let exec: OwnedExecutor | null = null;
    try {
      exec = await launchExecutor(ctx, { port: ctx.port, dataPath, skipInit: false });
      const generateMs = await ensureAgent(exec, true, ctx.runHolochain);
      const identity = await executorIdentity(exec.client);
      console.log(`[${ID}] executor pid ${exec.pid} up in ${exec.bootMs.toFixed(0)} ms; agent generated in ${generateMs?.toFixed(0)} ms`);

      const w = await measureIdleWindow(exec.pid, {
        settleSec: parameters.warmupSec,
        windowSec: parameters.idleSec,
        sampleSec: parameters.sampleSec,
        label: ID,
      });

      const endTime = Date.now();
      const s = idleSummary(w);
      const summary =
        `Holochain ${parameters.runHolochain ? "on" : "off"}: RSS ${s.rssMb} MB, swap ${s.swapMb} MB, ` +
        `${s.threads} threads, CPU ${s.cpuPercent}% of one core over ${parameters.idleSec}s, ${s.children} child processes`;
      const markdown = [
        `# ${ID} ${NAME}`,
        "",
        `Holochain: **${parameters.runHolochain ? "on" : "off"}**. Boot to healthy: ${exec.bootMs.toFixed(0)} ms. agent.generate: ${generateMs?.toFixed(0)} ms.`,
        "",
        idleWindowMarkdown(w, "Idle window"),
        "### Threads by pool (end of window)",
        "",
        threadGroupsMarkdown(w.end.threadGroups),
        "",
        "### smaps_rollup at end (MB)",
        "",
        Object.entries(w.end.smapsRollupKb).map(([k, v]) => `- ${k}: ${mb(v)}`).join("\n"),
        "",
      ].join("\n");

      return {
        scenario: scenarioName(ID, NAME),
        branch: ctx.branch,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        passed: true,
        metrics: {
          parameters,
          bootMs: Math.round(exec.bootMs),
          agentGenerateMs: generateMs == null ? null : Math.round(generateMs),
          ...s,
          idleWindow: w,
        },
        samples: [],
        summary,
        markdown,
        environment: identity as any,
      };
    } finally {
      await stopOwned(exec);
      removeDataDir(dataPath);
    }
  },
};

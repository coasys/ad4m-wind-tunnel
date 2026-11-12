/**
 * P2: Marginal Cost per Space
 *
 * What one more space costs an idle executor. Two variants:
 *   p2-perspectives    plain (local-only) perspectives
 *   p2-neighbourhoods  neighbourhoods on the server link language, each
 *                      with its own templated language (own UID), so its
 *                      own language instance and sync loop
 *
 * Spaces are added cumulatively up to each checkpoint in P2_COUNTS. At the
 * zero-space baseline and at each checkpoint the executor settles and an
 * idle window is measured. Delta per space = (checkpoint − baseline) / N.
 *
 * The neighbourhood variant skips honestly when the link-server /health does
 * not answer or the server link language bundle is missing.
 *
 * Tunables (env, defaults shown):
 *   P2_COUNTS             1,5,20,50   cumulative checkpoints
 *   P2_LINKS_PER_SPACE    10          links written into each space
 *   P2_WARMUP_SEC         60          wait before the baseline window
 *   P2_SETTLE_SEC         30          wait after creating spaces, before each window
 *   P2_IDLE_SEC           120         idle window length
 *   P2_SAMPLE_SEC         5
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import {
  envInt, envIntList, launchExecutor, stopOwned, ensureAgent, executorIdentity, ownedDataPath, removeDataDir,
  measureIdleWindow, idleWindowMarkdown, threadGroupsMarkdown, idleSummary, scenarioName, skippedResult,
  neighbourhoodPrerequisites, publishServerLinkLanguage, createPerspectiveSpace, createNeighbourhoodSpace,
  totalStoreSize, StoreSize, mdTable, r2, mb, stats, OwnedExecutor, IdleWindowResult, CreatedSpace, linkServerUrl,
} from "../platform/common.js";

type Kind = "perspective" | "neighbourhood";

function makeP2(kind: Kind): Scenario {
  const id = kind === "perspective" ? "p2-perspectives" : "p2-neighbourhoods";
  const name = kind === "perspective" ? "Space Cost Perspectives" : "Space Cost Neighbourhoods";
  return {
    id,
    name,
    description: `Marginal RSS, threads and idle CPU per added ${kind} at N = P2_COUNTS`,
    managesOwnEnvironment: true,

    async run(ctx: ScenarioContext): Promise<ScenarioResult> {
      const startTime = Date.now();
      const counts = [...new Set(envIntList("P2_COUNTS", [1, 5, 20, 50]))].filter((n) => n > 0).sort((a, b) => a - b);
      const parameters = {
        kind,
        counts,
        linksPerSpace: envInt("P2_LINKS_PER_SPACE", 10),
        warmupSec: envInt("P2_WARMUP_SEC", 60),
        settleSec: envInt("P2_SETTLE_SEC", 30),
        idleSec: envInt("P2_IDLE_SEC", 120),
        sampleSec: envInt("P2_SAMPLE_SEC", 5),
        runHolochain: ctx.runHolochain ?? true,
        linkServerUrl: kind === "neighbourhood" ? linkServerUrl() : null,
      };
      if (counts.length === 0) throw new Error("P2_COUNTS has no positive counts");
      if (kind === "neighbourhood") {
        const why = await neighbourhoodPrerequisites();
        if (why) return skippedResult(id, name, ctx, startTime, why, parameters);
      }

      const dataPath = ownedDataPath(ctx);
      let exec: OwnedExecutor | null = null;
      try {
        exec = await launchExecutor(ctx, { port: ctx.port, dataPath, skipInit: false });
        await ensureAgent(exec, true, ctx.runHolochain);
        const identity = await executorIdentity(exec.client);
        const sourceHash = kind === "neighbourhood" ? await publishServerLinkLanguage(exec.client) : null;

        const baseline = await measureIdleWindow(exec.pid, {
          settleSec: parameters.warmupSec, windowSec: parameters.idleSec, sampleSec: parameters.sampleSec, label: `${id} N=0`,
        });

        const spaces: CreatedSpace[] = [];
        const checkpoints: Array<{ n: number; createMsTotal: number; window: IdleWindowResult; store: StoreSize }> = [];
        for (const n of counts) {
          const t0 = performance.now();
          while (spaces.length < n) {
            const i = spaces.length;
            const tag = `${kind}-${i}`;
            spaces.push(
              kind === "perspective"
                ? await createPerspectiveSpace(exec.client, tag, parameters.linksPerSpace)
                : await createNeighbourhoodSpace(exec.client, sourceHash!, tag, parameters.linksPerSpace)
            );
          }
          const createMsTotal = performance.now() - t0;
          console.log(`[${id}] ${n} ${kind}s created (${createMsTotal.toFixed(0)} ms for this step)`);
          const window = await measureIdleWindow(exec.pid, {
            settleSec: parameters.settleSec, windowSec: parameters.idleSec, sampleSec: parameters.sampleSec, label: `${id} N=${n}`,
          });
          checkpoints.push({ n, createMsTotal, window, store: totalStoreSize(dataPath) });
        }

        const base = idleSummary(baseline);
        const rows = checkpoints.map((c) => {
          const s = idleSummary(c.window);
          return {
            n: c.n,
            rssMb: s.rssMb,
            swapMb: s.swapMb,
            threads: s.threads,
            cpuPercent: s.cpuPercent,
            children: s.children,
            hostBusyPercent: s.hostBusyPercent,
            deltaRssMbPerSpace: r2((s.rssMb - base.rssMb) / c.n),
            deltaRssPlusSwapMbPerSpace: r2((s.rssMb + s.swapMb - base.rssMb - base.swapMb) / c.n),
            deltaThreadsPerSpace: r2((s.threads - base.threads) / c.n),
            deltaCpuPercentPerSpace: r2((s.cpuPercent - base.cpuPercent) / c.n),
            storeKbPerSpace: r2(c.store.bytes / 1024 / c.n),
            walKbPerSpace: r2(c.store.walBytes / 1024 / c.n),
            createMsPerSpaceThisStep: r2(c.createMsTotal / (c.n - (checkpoints[checkpoints.indexOf(c) - 1]?.n ?? 0))),
          };
        });
        const last = rows[rows.length - 1];
        const createStats = stats(spaces.map((s) => s.createMs));

        const endTime = Date.now();
        const summary =
          `Holochain ${parameters.runHolochain ? "on" : "off"}, ${kind}s: baseline RSS ${base.rssMb} MB / ${base.threads} thr / ${base.cpuPercent}% CPU; ` +
          `at N=${last.n}: +${last.deltaRssMbPerSpace} MB, +${last.deltaThreadsPerSpace} threads, +${last.deltaCpuPercentPerSpace}% CPU per space`;
        const markdown = [
          `# ${id} ${name}`,
          "",
          `Holochain: **${parameters.runHolochain ? "on" : "off"}**. ${parameters.linksPerSpace} links per space. ` +
            `Settle ${parameters.settleSec} s then ${parameters.idleSec} s idle window at each checkpoint.` +
            (kind === "neighbourhood" ? ` Link server: ${parameters.linkServerUrl}.` : ""),
          "",
          "## Per checkpoint",
          "",
          mdTable(
            ["N", "RSS MB", "Swap MB", "Threads", "CPU %", "Children", "ΔRSS MB/space", "Δ(RSS+swap) MB/space", "Δthreads/space", "ΔCPU %/space", "Store KB/space", "of it WAL KB", "Create ms/space", "Host busy %"],
            [
              [0, base.rssMb, base.swapMb, base.threads, base.cpuPercent, base.children, "—", "—", "—", "—", "—", "—", "—", base.hostBusyPercent ?? NaN],
              ...rows.map((r) => [r.n, r.rssMb, r.swapMb, r.threads, r.cpuPercent, r.children, r.deltaRssMbPerSpace, r.deltaRssPlusSwapMbPerSpace, r.deltaThreadsPerSpace, r.deltaCpuPercentPerSpace, r.storeKbPerSpace, r.walKbPerSpace, r.createMsPerSpaceThisStep, r.hostBusyPercent ?? NaN]),
            ]
          ),
          "",
          `Create time per space: mean ${r2(createStats.mean)} ms, median ${r2(createStats.median)} ms, max ${r2(createStats.max)} ms.` +
            (kind === "neighbourhood"
              ? ` Creation includes the language-language upload to its remote store; applyTemplate retries: ${spaces.reduce((a, s) => a + (s.templateRetries ?? 0), 0)}.`
              : ""),
          "",
          idleWindowMarkdown(baseline, "Baseline (N = 0)"),
          idleWindowMarkdown(checkpoints[checkpoints.length - 1].window, `Last checkpoint (N = ${last.n})`),
          "### Threads by pool: baseline → last checkpoint",
          "",
          threadGroupsMarkdown(baseline.end.threadGroups),
          "",
          threadGroupsMarkdown(checkpoints[checkpoints.length - 1].window.end.threadGroups),
          "",
          `RSS samples are per-process RSS; at end of the last window RssAnon ${mb(checkpoints[checkpoints.length - 1].window.end.rssAnonKb)} MB.`,
          "",
        ].join("\n");

        return {
          scenario: scenarioName(id, name),
          branch: ctx.branch,
          startTime,
          endTime,
          durationMs: endTime - startTime,
          passed: true,
          metrics: {
            parameters,
            baseline: base,
            checkpoints: rows,
            createMs: createStats,
            templateRetriesTotal: spaces.reduce((a, s) => a + (s.templateRetries ?? 0), 0),
            spaces: spaces.map((s) => ({ uuid: s.uuid, kind: s.kind, linkLanguage: s.linkLanguage, createMs: r2(s.createMs), templateRetries: s.templateRetries ?? 0 })),
            rawWindows: { baseline, checkpoints: checkpoints.map((c) => ({ n: c.n, window: c.window })) },
          },
          samples: spaces.map((s, i) => ({ name: `create-${kind}-${i}`, durationMs: s.createMs, timestamp: startTime })),
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
}

export const p2SpaceCostPerspectives = makeP2("perspective");
export const p2SpaceCostNeighbourhoods = makeP2("neighbourhood");

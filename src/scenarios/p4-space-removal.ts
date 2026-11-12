/**
 * P4: Memory After Space Removal
 *
 * The executor has no "close" call for a space: a space is either loaded
 * (every perspective in the DB loads at boot) or removed with
 * `perspective.remove`, which deletes it. This scenario measures what
 * removal gives back.
 *
 *   1. baseline idle window (no spaces)
 *   2. add P4_COUNT plain perspectives (P4_LINKS links each) and, when the
 *      link-server is reachable, P4_COUNT neighbourhoods → idle window
 *   3. perspective.remove every plain perspective → idle window
 *   4. perspective.remove every neighbourhood → idle window
 *   5. language.remove each neighbourhood's templated link language → idle window
 *
 * For each step: RSS, RssAnon, swap, threads, CPU, and whether the
 * perspective's RocksDB directory is gone from disk. "Returned" =
 * (loaded − after) / (loaded − baseline).
 *
 * Neighbourhood steps are recorded as skipped (with the reason) when the
 * link-server is down; the plain-perspective steps still run.
 *
 * Tunables (env, defaults shown):
 *   P4_COUNT        20
 *   P4_LINKS        1000
 *   P4_WARMUP_SEC   60
 *   P4_SETTLE_SEC   30
 *   P4_IDLE_SEC     60
 *   P4_SAMPLE_SEC   5
 */

import { existsSync } from "fs";
import { join } from "path";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import {
  envInt, launchExecutor, stopOwned, ensureAgent, executorIdentity, ownedDataPath, removeDataDir,
  measureIdleWindow, idleWindowMarkdown, idleSummary, scenarioName, neighbourhoodPrerequisites,
  publishServerLinkLanguage, createPerspectiveSpace, createNeighbourhoodSpace, mdTable, r2, mb,
  OwnedExecutor, IdleWindowResult, CreatedSpace, threadGroupsMarkdown, timedEach,
} from "../platform/common.js";

const ID = "p4";
const NAME = "Space Removal";

interface Step {
  step: string;
  window: IdleWindowResult;
  note: string;
}

export const p4SpaceRemoval: Scenario = {
  id: ID,
  name: NAME,
  description: "What perspective.remove (and language.remove) give back: RSS, threads, CPU, disk",
  managesOwnEnvironment: true,

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const startTime = Date.now();
    const parameters = {
      count: envInt("P4_COUNT", 20),
      links: envInt("P4_LINKS", 1000),
      warmupSec: envInt("P4_WARMUP_SEC", 60),
      settleSec: envInt("P4_SETTLE_SEC", 30),
      idleSec: envInt("P4_IDLE_SEC", 60),
      sampleSec: envInt("P4_SAMPLE_SEC", 5),
      runHolochain: ctx.runHolochain ?? true,
    };
    const nhSkipReason = await neighbourhoodPrerequisites();
    const dataPath = ownedDataPath(ctx);
    let exec: OwnedExecutor | null = null;
    try {
      exec = await launchExecutor(ctx, { port: ctx.port, dataPath, skipInit: false });
      await ensureAgent(exec, true, ctx.runHolochain);
      const identity = await executorIdentity(exec.client);
      const e = exec;
      const idle = (label: string, settleSec = parameters.settleSec) =>
        measureIdleWindow(e.pid, { settleSec, windowSec: parameters.idleSec, sampleSec: parameters.sampleSec, label: `${ID} ${label}` });
      const onDisk = (spaces: CreatedSpace[]) => spaces.filter((s) => existsSync(join(dataPath, "perspectives", s.uuid))).length;

      const steps: Step[] = [];
      steps.push({ step: "baseline", window: await idle("baseline", parameters.warmupSec), note: "no spaces" });

      const sourceHash = nhSkipReason ? null : await publishServerLinkLanguage(e.client);
      const persp: CreatedSpace[] = [];
      const nh: CreatedSpace[] = [];
      for (let i = 0; i < parameters.count; i++) persp.push(await createPerspectiveSpace(e.client, `p4p${i}`, parameters.links));
      if (sourceHash) {
        for (let i = 0; i < parameters.count; i++) nh.push(await createNeighbourhoodSpace(e.client, sourceHash, `p4n${i}`, parameters.links));
      }
      steps.push({
        step: "loaded",
        window: await idle("loaded"),
        note: `${persp.length} perspectives + ${nh.length} neighbourhoods, ${parameters.links} links each; on disk: ${onDisk(persp) + onDisk(nh)} store dirs`,
      });

      const removeAll = (spaces: CreatedSpace[]) =>
        timedEach(spaces, (s) => e.client.removePerspective(s.uuid), (s) => s.uuid);

      const rp = await removeAll(persp);
      steps.push({
        step: "perspectives removed",
        window: await idle("perspectives removed"),
        note: `perspective.remove ×${persp.length} in ${r2(rp.ms)} ms, ${rp.errors.length} errors; store dirs left: ${onDisk(persp)}`,
      });

      let rn = { ms: 0, errors: [] as string[] };
      let rl = { ms: 0, errors: [] as string[] };
      if (nh.length > 0) {
        rn = await removeAll(nh);
        steps.push({
          step: "neighbourhoods removed",
          window: await idle("neighbourhoods removed"),
          note: `perspective.remove ×${nh.length} in ${r2(rn.ms)} ms, ${rn.errors.length} errors; store dirs left: ${onDisk(nh)}`,
        });
        // Time the calls before the idle window starts (timedEach returns at once).
        rl = await timedEach(nh, (s) => e.client.call("language.remove", { address: s.linkLanguage }), (s) => String(s.linkLanguage));
        steps.push({
          step: "link languages removed",
          window: await idle("link languages removed"),
          note: `language.remove ×${nh.length} in ${r2(rl.ms)} ms, ${rl.errors.length} errors`,
        });
      }

      const base = idleSummary(steps[0].window);
      const loaded = idleSummary(steps[1].window);
      const grown = loaded.rssMb - base.rssMb;
      const rows = steps.map((s) => {
        const x = idleSummary(s.window);
        return {
          step: s.step,
          rssMb: x.rssMb,
          rssAnonMb: mb(s.window.end.rssAnonKb),
          swapMb: x.swapMb,
          threads: x.threads,
          cpuPercent: x.cpuPercent,
          returnedPercentOfGrowth: s.step === "baseline" || s.step === "loaded" || grown <= 0 ? null : r2(((loaded.rssMb - x.rssMb) / grown) * 100),
          note: s.note,
        };
      });
      const final = rows[rows.length - 1];

      const endTime = Date.now();
      const summary =
        `baseline ${base.rssMb} MB → loaded ${loaded.rssMb} MB (${loaded.threads} thr) → after removal ${final.rssMb} MB (${final.threads} thr); ` +
        `returned ${final.returnedPercentOfGrowth ?? "n/a"}% of growth` + (nhSkipReason ? ` [neighbourhood steps skipped: ${nhSkipReason}]` : "");
      const markdown = [
        `# ${ID} ${NAME}`,
        "",
        `Holochain: **${parameters.runHolochain ? "on" : "off"}**. The executor has no close call; \`perspective.remove\` deletes the space. ` +
          `Each step: settle ${parameters.settleSec} s, then ${parameters.idleSec} s idle window.`,
        nhSkipReason ? `\n**Neighbourhood steps skipped:** ${nhSkipReason}\n` : "",
        mdTable(
          ["Step", "RSS MB", "RssAnon MB", "Swap MB", "Threads", "CPU %", "Returned % of growth", "Note"],
          rows.map((r) => [r.step, r.rssMb, r.rssAnonMb, r.swapMb, r.threads, r.cpuPercent, r.returnedPercentOfGrowth ?? "—", r.note])
        ),
        "",
        rl.errors.length ? `language.remove errors (first 3): ${rl.errors.slice(0, 3).join("; ")}\n` : "",
        ...steps.map((s) => idleWindowMarkdown(s.window, s.step)),
        "### Threads by pool: loaded → after last step",
        "",
        threadGroupsMarkdown(steps[1].window.end.threadGroups),
        "",
        threadGroupsMarkdown(steps[steps.length - 1].window.end.threadGroups),
        "",
      ].join("\n");

      return {
        scenario: scenarioName(ID, NAME),
        branch: ctx.branch,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        passed: rp.errors.length === 0 && rn.errors.length === 0,
        metrics: {
          parameters,
          neighbourhoodStepsSkipped: nhSkipReason,
          steps: rows,
          removeErrors: [...rp.errors, ...rn.errors],
          languageRemoveErrors: rl.errors,
          removeMs: { perspectives: r2(rp.ms), neighbourhoods: r2(rn.ms), linkLanguages: r2(rl.ms) },
          rawWindows: steps.map((s) => ({ step: s.step, window: s.window })),
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

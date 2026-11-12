/**
 * P5: Storage Attribution
 *
 * Where per-space memory goes, on disk and in RAM.
 *
 * Disk: each perspective is an Oxigraph store on RocksDB at
 * `<data>/perspectives/<uuid>`. For one perspective per size in
 * P5_LINK_COUNTS (and one neighbourhood when the link-server is up) this
 * records the store directory size and bytes per link, plus the size of every
 * top-level entry in the data dir (SQLite DB, languages, Holochain, ...).
 *
 * RAM: after each space is created and settles, the RSS / RssAnon / RssFile
 * step is attributed to that space. Then P5_QUERY_ROUNDS full queries run on
 * the largest store and the RSS step is attributed to the query path (the
 * same write-vs-query split S15 makes, but as a level, not a slope).
 * smaps_rollup is recorded before and after.
 *
 * Tunables (env, defaults shown):
 *   P5_LINK_COUNTS    0,100,1000,10000
 *   P5_NH_LINKS       100
 *   P5_SETTLE_SEC     15
 *   P5_QUERY_ROUNDS   20
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";
import { procStatus } from "../proc-metrics.js";
import {
  envInt, envIntList, launchExecutor, stopOwned, ensureAgent, executorIdentity, ownedDataPath, removeDataDir,
  scenarioName, neighbourhoodPrerequisites, publishServerLinkLanguage, createPerspectiveSpace, createNeighbourhoodSpace,
  perspectiveStoreSizes, dataDirBreakdown, snapshotProcess, mdTable, r2, mb, OwnedExecutor, CreatedSpace,
} from "../platform/common.js";

const ID = "p5";
const NAME = "Storage Attribution";

export const p5StorageAttribution: Scenario = {
  id: ID,
  name: NAME,
  description: "RocksDB store size per perspective, bytes per link, data dir breakdown, RSS step per store and per query load",
  managesOwnEnvironment: true,

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const startTime = Date.now();
    const parameters = {
      linkCounts: envIntList("P5_LINK_COUNTS", [0, 100, 1000, 10000]),
      nhLinks: envInt("P5_NH_LINKS", 100),
      settleSec: envInt("P5_SETTLE_SEC", 15),
      queryRounds: envInt("P5_QUERY_ROUNDS", 20),
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
      const mem = () => {
        const s = procStatus(e.pid);
        return { rssMb: mb(s?.vmRssKb), anonMb: mb(s?.rssAnonKb), fileMb: mb(s?.rssFileKb), swapMb: mb(s?.vmSwapKb), threads: s?.threads ?? 0 };
      };

      await sleep(parameters.settleSec * 1000);
      const smapsBefore = snapshotProcess(e.pid).smapsRollupKb;
      const dataDirBefore = dataDirBreakdown(dataPath);
      let prev = mem();
      const baselineMem = prev;

      const sourceHash = nhSkipReason ? null : await publishServerLinkLanguage(e.client);
      const plan: Array<{ kind: "perspective" | "neighbourhood"; links: number }> = [
        ...parameters.linkCounts.map((links) => ({ kind: "perspective" as const, links })),
        ...(sourceHash ? [{ kind: "neighbourhood" as const, links: parameters.nhLinks }] : []),
      ];
      const rows: Array<{
        kind: string; links: number; uuid: string; storeKb: number; walKb: number; bytesPerLink: number | null;
        rssStepMb: number; anonStepMb: number; fileStepMb: number; threadStep: number; createMs: number;
      }> = [];
      let largest: CreatedSpace | null = null;
      let largestLinks = -1;
      for (const [i, p] of plan.entries()) {
        const space = p.kind === "perspective"
          ? await createPerspectiveSpace(e.client, `p5-${i}`, p.links, 1000)
          : await createNeighbourhoodSpace(e.client, sourceHash!, `p5-${i}`, p.links);
        await sleep(parameters.settleSec * 1000);
        const now = mem();
        const store = perspectiveStoreSizes(dataPath)[space.uuid];
        const storeBytes = store?.bytes ?? 0;
        rows.push({
          kind: p.kind,
          links: p.links,
          uuid: space.uuid,
          storeKb: r2(storeBytes / 1024),
          walKb: r2((store?.walBytes ?? 0) / 1024),
          bytesPerLink: p.links > 0 ? r2(storeBytes / p.links) : null,
          rssStepMb: r2(now.rssMb - prev.rssMb),
          anonStepMb: r2(now.anonMb - prev.anonMb),
          fileStepMb: r2(now.fileMb - prev.fileMb),
          threadStep: now.threads - prev.threads,
          createMs: r2(space.createMs),
        });
        console.log(`[${ID}] ${p.kind} ${p.links} links: store ${r2(storeBytes / 1024)} KB, RSS step ${r2(now.rssMb - prev.rssMb)} MB`);
        prev = now;
        if (p.kind === "perspective" && p.links > largestLinks) {
          largest = space;
          largestLinks = p.links;
        }
      }

      // Query path: repeated full reads of the largest store.
      let query: { rounds: number; links: number; meanMs: number; rssStepMb: number; anonStepMb: number } | null = null;
      if (largest && parameters.queryRounds > 0) {
        const before = mem();
        const t0 = performance.now();
        for (let r = 0; r < parameters.queryRounds; r++) {
          await e.client.call("perspective.queryLinks", { uuid: largest.uuid });
        }
        const meanMs = (performance.now() - t0) / parameters.queryRounds;
        await sleep(parameters.settleSec * 1000);
        const after = mem();
        query = { rounds: parameters.queryRounds, links: largestLinks, meanMs: r2(meanMs), rssStepMb: r2(after.rssMb - before.rssMb), anonStepMb: r2(after.anonMb - before.anonMb) };
        prev = after;
      }

      const smapsAfter = snapshotProcess(e.pid).smapsRollupKb;
      const dataDirAfter = dataDirBreakdown(dataPath);
      const endMem = mem();
      const endTime = Date.now();

      const big = rows.filter((r) => r.kind === "perspective" && r.links > 0).sort((a, b) => b.links - a.links)[0];
      const empty = rows.find((r) => r.kind === "perspective" && r.links === 0);
      const summary =
        (empty ? `empty perspective store ${empty.storeKb} KB; ` : "") +
        (big ? `${big.links}-link store ${big.storeKb} KB (${big.bytesPerLink} B/link), RSS step ${big.rssStepMb} MB; ` : "") +
        `RSS ${baselineMem.rssMb} → ${endMem.rssMb} MB` +
        (nhSkipReason ? ` [neighbourhood row skipped: ${nhSkipReason}]` : "");
      const keys = [...new Set([...Object.keys(dataDirBefore), ...Object.keys(dataDirAfter)])].sort();
      const smapsKeys = ["Rss", "Pss", "Pss_Anon", "Pss_File", "Anonymous", "Private_Dirty", "Shared_Clean", "Swap"];
      const markdown = [
        `# ${ID} ${NAME}`,
        "",
        `Holochain: **${parameters.runHolochain ? "on" : "off"}**. Each RSS step is read ${parameters.settleSec} s after the space is created. ` +
          "Steps include allocator noise of a few MB; only steps well above that are attributable. " +
          "Store sizes are read while the executor runs: recent writes are still in the RocksDB WAL (the WAL KB column), " +
          "so bytes/link is the size after writing, not after a flush or compaction.",
        nhSkipReason ? `\n**Neighbourhood row skipped:** ${nhSkipReason}\n` : "",
        "## Per store",
        "",
        mdTable(
          ["Kind", "Links", "Store KB (perspectives/<uuid>)", "of it WAL KB", "Bytes/link", "RSS step MB", "RssAnon step MB", "RssFile step MB", "Thread step", "Create ms"],
          rows.map((r) => [r.kind, r.links, r.storeKb, r.walKb, r.bytesPerLink ?? "—", r.rssStepMb, r.anonStepMb, r.fileStepMb, r.threadStep, r.createMs])
        ),
        "",
        query ? `Query path: ${query.rounds} full queries of the ${query.links}-link store, mean ${query.meanMs} ms; RSS step ${query.rssStepMb} MB (RssAnon ${query.anonStepMb} MB).\n` : "",
        "## Data dir (top level, KB)",
        "",
        mdTable(["Entry", "Before spaces", "After spaces"], keys.map((k) => [k, r2((dataDirBefore[k] ?? 0) / 1024), r2((dataDirAfter[k] ?? 0) / 1024)])),
        "",
        "## smaps_rollup (MB)",
        "",
        mdTable(["Field", "Before spaces", "After spaces"], smapsKeys.map((k) => [k, mb(smapsBefore[k]), mb(smapsAfter[k])])),
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
          neighbourhoodRowSkipped: nhSkipReason,
          baselineMem,
          endMem,
          stores: rows,
          query,
          dataDirBytesBefore: dataDirBefore,
          dataDirBytesAfter: dataDirAfter,
          smapsRollupKbBefore: smapsBefore,
          smapsRollupKbAfter: smapsAfter,
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

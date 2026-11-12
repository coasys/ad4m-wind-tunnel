/**
 * P3: Cold Open
 *
 * What a restart costs when the executor already holds data.
 *
 * Part A — one big space. For each size in P3_LINK_COUNTS: fill one
 * perspective, stop the executor, restart it on the same data dir and record
 *   - boot time (spawn → /health and RPC answer),
 *   - agent.unlock time,
 *   - time to first query answer (spawn → first queryLinks reply, a
 *     filtered query on one source),
 *   - a full queryLinks (all links) time and count,
 *   - RSS right after boot, after the first query, and after P3_SETTLE_SEC.
 *
 * Part B — many spaces. Fill P3_SPACES perspectives and restart three times:
 *   1. first restart after the writes, all spaces queried at once,
 *   2. all spaces queried one after another (time per space and total),
 *   3. all spaces queried at once.
 * The executor does not flush RocksDB memtables on shutdown, so the first
 * open after writes replays the write-ahead log (WAL) of every store and
 * ends with a much larger RSS. Restart 1 takes that cost, so restarts 2 and 3
 * compare the query modes on the same flushed stores. Part A restarts are
 * all first opens after writes. The WAL size before each restart is recorded.
 *
 * The executor has no explicit open call: perspectives load at boot. "Open"
 * here is the first query after a restart.
 *
 * Tunables (env, defaults shown):
 *   P3_LINK_COUNTS    5000,50000
 *   P3_SPACES         30
 *   P3_SPACE_LINKS    1000        links per space in part B
 *   P3_SETTLE_SEC     30
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";
import { procStatus } from "../proc-metrics.js";
import {
  envInt, envIntList, launchExecutor, stopOwned, ensureAgent, executorIdentity, ownedDataPath, removeDataDir,
  scenarioName, createPerspectiveSpace, perspectiveStoreSizes, totalStoreSize, mdTable, r2, mb, stats, OwnedExecutor, Stats, untilFound,
} from "../platform/common.js";

const ID = "p3";
const NAME = "Cold Open";

interface RestartMeasure {
  bootMs: number;
  unlockMs: number | null;
  firstQueryMs: number;
  /** "Perspective not found" answers before the perspectives were open (see untilFound). */
  notFoundAnswers: number;
  spawnToFirstAnswerMs: number;
  rssAfterBootMb: number;
  rssAfterFirstQueryMb: number;
  rssAfterSettleMb: number;
  swapAfterSettleMb: number;
  threadsAfterSettle: number;
}

async function rss(pid: number) {
  const s = procStatus(pid);
  return { rss: mb(s?.vmRssKb), swap: mb(s?.vmSwapKb), threads: s?.threads ?? 0 };
}

function linksIn(res: any): number {
  return Array.isArray(res) ? res.length : Array.isArray(res?.links) ? res.links.length : -1;
}

export const p3ColdOpen: Scenario = {
  id: ID,
  name: NAME,
  description: "Restart with 5k/50k-link spaces: boot, time to first query, RSS; then open and query 30 spaces",
  managesOwnEnvironment: true,

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const startTime = Date.now();
    const parameters = {
      linkCounts: envIntList("P3_LINK_COUNTS", [5000, 50000]),
      spaces: envInt("P3_SPACES", 30),
      spaceLinks: envInt("P3_SPACE_LINKS", 1000),
      settleSec: envInt("P3_SETTLE_SEC", 30),
      runHolochain: ctx.runHolochain ?? true,
    };
    const base = ownedDataPath(ctx);
    const dirs: string[] = [];
    let exec: OwnedExecutor | null = null;
    let identity: { ad4mCommit: string | null; ad4mExecutorVersion: string | null } = { ad4mCommit: null, ad4mExecutorVersion: null };

    /** Restart on `dataPath`, unlock, run `firstQuery` (returns the "not found" answers it waited through), record. */
    const restart = async (dataPath: string, firstQuery: (e: OwnedExecutor) => Promise<number>): Promise<RestartMeasure> => {
      exec = await launchExecutor(ctx, { port: ctx.port, dataPath, skipInit: true });
      const afterBoot = await rss(exec.pid);
      const unlockMs = await ensureAgent(exec, false, ctx.runHolochain);
      const q0 = performance.now();
      const notFoundAnswers = await firstQuery(exec);
      const q1 = performance.now();
      const afterQuery = await rss(exec.pid);
      await sleep(parameters.settleSec * 1000);
      const afterSettle = await rss(exec.pid);
      return {
        bootMs: r2(exec.bootMs),
        unlockMs: unlockMs == null ? null : r2(unlockMs),
        firstQueryMs: r2(q1 - q0),
        notFoundAnswers,
        spawnToFirstAnswerMs: r2(q1 - exec.spawnedAt),
        rssAfterBootMb: afterBoot.rss,
        rssAfterFirstQueryMb: afterQuery.rss,
        rssAfterSettleMb: afterSettle.rss,
        swapAfterSettleMb: afterSettle.swap,
        threadsAfterSettle: afterSettle.threads,
      };
    };

    try {
      // ── Part A: one big space per size ──
      const big: Array<RestartMeasure & { links: number; fillMs: number; storeMb: number; walMb: number; fullQueryMs: number; fullQueryCount: number; rssBeforeStopMb: number }> = [];
      for (const links of parameters.linkCounts) {
        const dataPath = `${base}-p3-${links}`;
        dirs.push(dataPath);
        exec = await launchExecutor(ctx, { port: ctx.port, dataPath, skipInit: false });
        await ensureAgent(exec, true, ctx.runHolochain);
        identity = await executorIdentity(exec.client);
        const f0 = performance.now();
        const space = await createPerspectiveSpace(exec.client, `big${links}`, links, 1000);
        const fillMs = performance.now() - f0;
        const check = await exec.client.call("perspective.queryLinks", { uuid: space.uuid });
        if (linksIn(check) !== links) throw new Error(`filled ${links} links but queryLinks returned ${linksIn(check)}`);
        const rssBeforeStopMb = (await rss(exec.pid)).rss;
        console.log(`[${ID}] ${links} links written in ${fillMs.toFixed(0)} ms; RSS ${rssBeforeStopMb} MB; restarting`);
        await stopOwned(exec);
        exec = null;
        const store = perspectiveStoreSizes(dataPath)[space.uuid];
        const storeMb = r2((store?.bytes ?? 0) / 1048576);
        const walMb = r2((store?.walBytes ?? 0) / 1048576);

        const m = await restart(dataPath, async (e) => {
          const r = await untilFound(() =>
            e.client.call("perspective.queryLinks", { uuid: space.uuid, source: `ad4m://wt/big${links}/item-0` })
          );
          if (linksIn(r.value) < 1) throw new Error(`first query after restart returned ${linksIn(r.value)} links`);
          return r.notFoundAnswers;
        });
        const fq0 = performance.now();
        const full = await exec!.client.call("perspective.queryLinks", { uuid: space.uuid });
        const fullQueryMs = r2(performance.now() - fq0);
        big.push({ links, fillMs: r2(fillMs), storeMb, walMb, fullQueryMs, fullQueryCount: linksIn(full), rssBeforeStopMb, ...m });
        console.log(`[${ID}] ${links} links: boot ${m.bootMs} ms, first answer ${m.spawnToFirstAnswerMs} ms after spawn, RSS ${m.rssAfterSettleMb} MB`);
        await stopOwned(exec);
        exec = null;
        removeDataDir(dataPath);
      }

      // ── Part B: many spaces ──
      const manyPath = `${base}-p3-many`;
      dirs.push(manyPath);
      exec = await launchExecutor(ctx, { port: ctx.port, dataPath: manyPath, skipInit: false });
      await ensureAgent(exec, true, ctx.runHolochain);
      identity = await executorIdentity(exec.client);
      const uuids: string[] = [];
      for (let i = 0; i < parameters.spaces; i++) {
        uuids.push((await createPerspectiveSpace(exec.client, `s${i}`, parameters.spaceLinks, 1000)).uuid);
      }
      const manyRssBeforeStopMb = (await rss(exec.pid)).rss;
      await stopOwned(exec);
      exec = null;
      const storeAfterWrites = totalStoreSize(manyPath);
      const storeTotalMb = r2(storeAfterWrites.bytes / 1048576);

      /** Time to answer space i, including any wait while the executor still opens it. */
      const queryOne = async (e: OwnedExecutor, i: number): Promise<{ ms: number; notFound: number }> => {
        const r = await untilFound(() =>
          e.client.call("perspective.queryLinks", { uuid: uuids[i], source: `ad4m://wt/s${i}/item-0` })
        );
        if (linksIn(r.value) < 1) throw new Error(`space ${i}: query returned ${linksIn(r.value)} links`);
        return { ms: r.totalMs, notFound: r.notFoundAnswers };
      };

      /** Restart on the many-space dir and query every space, one after another or all at once. */
      const runMode = async (concurrent: boolean) => {
        const walMbBefore = r2(totalStoreSize(manyPath).walBytes / 1048576);
        let times: number[] = [];
        let totalMs = 0;
        const m = await restart(manyPath, async (e) => {
          const t0 = performance.now();
          let qs: Array<{ ms: number; notFound: number }> = [];
          if (concurrent) qs = await Promise.all(uuids.map((_, i) => queryOne(e, i)));
          else for (let i = 0; i < uuids.length; i++) qs.push(await queryOne(e, i));
          totalMs = performance.now() - t0;
          times = qs.map((q) => q.ms);
          return qs.reduce((a, q) => a + q.notFound, 0);
        });
        await stopOwned(exec);
        exec = null;
        const perQuery: Stats = stats(times);
        return { ...m, walMbBefore, totalMs: r2(totalMs), perQuery, raw: times.map(r2) };
      };
      const afterWrites = await runMode(true);
      const seq = await runMode(false);
      const conc = await runMode(true);
      const modes = [
        ["first restart after writes (WAL replay), at once", afterWrites],
        ["one after another", seq],
        ["at once", conc],
      ] as const;
      const endTime = Date.now();

      const summary =
        big.map((b) => `${b.links} links: boot ${b.bootMs} ms, first answer ${b.spawnToFirstAnswerMs} ms, RSS ${b.rssAfterSettleMb} MB`).join("; ") +
        `; ${parameters.spaces} spaces: boot ${seq.bootMs} ms, sequential ${seq.totalMs} ms, concurrent ${conc.totalMs} ms, ` +
        `RSS after settle ${afterWrites.rssAfterSettleMb} MB on first restart after writes, ${seq.rssAfterSettleMb} / ${conc.rssAfterSettleMb} MB sequential / concurrent`;
      const markdown = [
        `# ${ID} ${NAME}`,
        "",
        `Holochain: **${parameters.runHolochain ? "on" : "off"}**. RSS read ${parameters.settleSec} s after the first query for "after settle".`,
        "Perspectives load at boot; there is no open call. Boot = spawn to /health plus one RPC answer.",
        "The executor answers /health before it has opened its stored perspectives (each opens in a background task).",
        "A query that arrives first gets \"Perspective not found\"; the harness retries every 25 ms and counts those answers.",
        "First query ms and spawn → first answer ms include that wait.",
        "The executor does not flush RocksDB memtables on shutdown: the first open after writes replays the WAL and ends with a larger RSS.",
        "Every part A restart is such a first open. In part B, restart 1 takes the replay, so the two query modes compare equal stores.",
        "",
        "## One large space",
        "",
        mdTable(
          ["Links", "Store MB", "WAL MB", "Boot ms", "Unlock ms", "First query ms", "Not-found answers", "Spawn → first answer ms", "Full query ms (count)", "RSS after boot MB", "RSS after 1st query MB", "RSS after settle MB", "RSS before restart MB", "Threads"],
          big.map((b) => [b.links, b.storeMb, b.walMb, b.bootMs, b.unlockMs ?? "n/a", b.firstQueryMs, b.notFoundAnswers, b.spawnToFirstAnswerMs, `${b.fullQueryMs} (${b.fullQueryCount})`, b.rssAfterBootMb, b.rssAfterFirstQueryMb, b.rssAfterSettleMb, b.rssBeforeStopMb, b.threadsAfterSettle])
        ),
        "",
        `## ${parameters.spaces} spaces × ${parameters.spaceLinks} links (store ${storeTotalMb} MB total after writes, ${r2(storeAfterWrites.walBytes / 1048576)} MB of it WAL)`,
        "",
        mdTable(
          ["Restart", "WAL MB before", "Boot ms", "Unlock ms", "All queries ms", "Not-found answers", "Per query mean / median / max ms", "Spawn → last answer ms", "RSS after boot MB", "RSS after queries MB", "RSS after settle MB", "Threads"],
          modes.map(([label, x]) => [label, x.walMbBefore, x.bootMs, x.unlockMs ?? "n/a", x.totalMs, x.notFoundAnswers, `${r2(x.perQuery.mean)} / ${r2(x.perQuery.median)} / ${r2(x.perQuery.max)}`, x.spawnToFirstAnswerMs, x.rssAfterBootMb, x.rssAfterFirstQueryMb, x.rssAfterSettleMb, x.threadsAfterSettle])
        ),
        "",
        `RSS with all ${parameters.spaces} spaces just written, before the restart: ${manyRssBeforeStopMb} MB.`,
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
          bigSpaces: big,
          manySpaces: {
            storeTotalMb,
            walTotalMb: r2(storeAfterWrites.walBytes / 1048576),
            rssBeforeRestartMb: manyRssBeforeStopMb,
            afterWrites,
            sequential: seq,
            concurrent: conc,
          },
        },
        samples: [],
        summary,
        markdown,
        environment: identity as any,
      };
    } finally {
      await stopOwned(exec);
      for (const d of dirs) removeDataDir(d);
    }
  },
};

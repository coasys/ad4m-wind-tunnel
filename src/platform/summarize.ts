/**
 * Platform baseline summary: spread across repeated runs.
 *
 *   npx tsx src/platform/summarize.ts <results-dir>
 *
 * Reads every `<label>/<p-scenario>[-run<i>].json` under <results-dir>,
 * groups the runs of one scenario in one label (e.g. `dev-abc-hc-off`),
 * pulls the headline numbers of each run and writes `<results-dir>/SUMMARY.md`
 * and `SUMMARY.json` with n, mean, min, max and stddev per number.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { stats, mdTable, r2 } from "./common.js";
import type { ScenarioResult } from "../scenario.js";

type Headline = Record<string, number | null | undefined>;

/** Headline numbers of one run, by scenario id. */
export function headlines(id: string, m: Record<string, any>): Headline {
  const h: Headline = {};
  if (m.skipped) return h;
  switch (id) {
    case "p1": {
      Object.assign(h, {
        "CPU % of one core (idle window)": m.cpuPercent,
        "RSS MB": m.rssMb,
        "VmSwap MB": m.swapMb,
        "Threads": m.threads,
        "Child processes": m.children,
        "Boot ms (spawn to healthy)": m.bootMs,
        "agent.generate ms": m.agentGenerateMs,
        "Host busy % during window": m.hostBusyPercent,
      });
      for (const g of m.idleWindow?.end?.threadGroups ?? []) h[`Threads in pool ${g.pool}`] = g.count;
      for (const p of (m.idleWindow?.cpuByPool ?? []).slice(0, 5)) h[`CPU % pool ${p.pool}`] = p.cpuPercent;
      break;
    }
    case "p2-perspectives":
    case "p2-neighbourhoods": {
      const b = m.baseline ?? {};
      Object.assign(h, { "N=0 RSS MB": b.rssMb, "N=0 threads": b.threads, "N=0 CPU %": b.cpuPercent });
      for (const c of m.checkpoints ?? []) {
        h[`N=${c.n} RSS MB`] = c.rssMb;
        h[`N=${c.n} threads`] = c.threads;
        h[`N=${c.n} CPU %`] = c.cpuPercent;
        h[`N=${c.n} ΔRSS MB per space`] = c.deltaRssMbPerSpace;
        h[`N=${c.n} Δthreads per space`] = c.deltaThreadsPerSpace;
        h[`N=${c.n} ΔCPU % per space`] = c.deltaCpuPercentPerSpace;
        h[`N=${c.n} store KB per space`] = c.storeKbPerSpace;
        h[`N=${c.n} WAL KB per space`] = c.walKbPerSpace;
      }
      h["Create ms per space (median)"] = m.createMs?.median;
      if (m.templateRetriesTotal !== undefined) h["applyTemplate retries"] = m.templateRetriesTotal;
      break;
    }
    case "p3": {
      for (const b of m.bigSpaces ?? []) {
        const k = `${b.links} links`;
        Object.assign(h, {
          [`${k}: store MB`]: b.storeMb,
          [`${k}: WAL MB`]: b.walMb,
          [`${k}: boot ms`]: b.bootMs,
          [`${k}: unlock ms`]: b.unlockMs,
          [`${k}: first query ms`]: b.firstQueryMs,
          [`${k}: not-found answers before open`]: b.notFoundAnswers,
          [`${k}: spawn to first answer ms`]: b.spawnToFirstAnswerMs,
          [`${k}: full query ms`]: b.fullQueryMs,
          [`${k}: RSS after boot MB`]: b.rssAfterBootMb,
          [`${k}: RSS after first query MB`]: b.rssAfterFirstQueryMb,
          [`${k}: RSS after settle MB`]: b.rssAfterSettleMb,
          [`${k}: RSS before restart MB`]: b.rssBeforeStopMb,
        });
      }
      const ms = m.manySpaces;
      if (ms) {
        for (const mode of ["afterWrites", "sequential", "concurrent"] as const) {
          const x = ms[mode];
          if (!x) continue; // results from before the afterWrites restart existed
          Object.assign(h, {
            [`spaces ${mode}: boot ms`]: x.bootMs,
            [`spaces ${mode}: unlock ms`]: x.unlockMs,
            [`spaces ${mode}: all queries ms`]: x.totalMs,
            [`spaces ${mode}: not-found answers before open`]: x.notFoundAnswers,
            [`spaces ${mode}: per query max ms`]: x.perQuery?.max,
            [`spaces ${mode}: spawn to last answer ms`]: x.spawnToFirstAnswerMs,
            [`spaces ${mode}: RSS after settle MB`]: x.rssAfterSettleMb,
          });
        }
        h["spaces: store MB total"] = ms.storeTotalMb;
        h["spaces: WAL MB total"] = ms.walTotalMb;
      }
      break;
    }
    case "p4": {
      for (const s of m.steps ?? []) {
        h[`${s.step}: RSS MB`] = s.rssMb;
        h[`${s.step}: RssAnon MB`] = s.rssAnonMb;
        h[`${s.step}: threads`] = s.threads;
        h[`${s.step}: CPU %`] = s.cpuPercent;
        if (s.returnedPercentOfGrowth != null) h[`${s.step}: returned % of growth`] = s.returnedPercentOfGrowth;
      }
      break;
    }
    case "p5": {
      for (const s of m.stores ?? []) {
        const k = `${s.kind} ${s.links} links`;
        h[`${k}: store KB`] = s.storeKb;
        h[`${k}: WAL KB`] = s.walKb;
        if (s.bytesPerLink != null) h[`${k}: bytes per link`] = s.bytesPerLink;
        h[`${k}: RSS step MB`] = s.rssStepMb;
        h[`${k}: thread step`] = s.threadStep;
      }
      if (m.query) h[`query path (${m.query.rounds} full reads of ${m.query.links} links): RSS step MB`] = m.query.rssStepMb;
      h["RSS before spaces MB"] = m.baselineMem?.rssMb;
      h["RSS after all MB"] = m.endMem?.rssMb;
      break;
    }
  }
  return h;
}

interface Group {
  label: string;
  id: string;
  runs: ScenarioResult[];
}

function scenarioId(file: string): string | null {
  const m = file.match(/^(p1|p2-perspectives|p2-neighbourhoods|p3|p4|p5)-/);
  return m ? m[1] : null;
}

export function collect(dir: string): Group[] {
  const groups = new Map<string, Group>();
  for (const label of readdirSync(dir).sort()) {
    const sub = join(dir, label);
    if (!statSync(sub).isDirectory() || label === "logs" || label === "smoke") continue;
    for (const f of readdirSync(sub).sort()) {
      if (!f.endsWith(".json")) continue;
      const id = scenarioId(f);
      if (!id) continue;
      const r = JSON.parse(readFileSync(join(sub, f), "utf8")) as ScenarioResult;
      const key = `${label}/${id}`;
      const g = groups.get(key) ?? { label, id, runs: [] };
      g.runs.push(r);
      groups.set(key, g);
    }
  }
  return [...groups.values()];
}

export function summarize(dir: string): { markdown: string; json: unknown } {
  const groups = collect(dir);
  const out: string[] = [
    "# Platform baseline summary",
    "",
    "Spread across repeated runs of each scenario. Values are measured; n is the number of runs.",
    "CPU % is percent of one core. Load average is the 1-minute value at run start → end.",
    "",
  ];
  const json: any[] = [];
  for (const g of groups) {
    const env = g.runs[0].environment;
    out.push(`## ${g.id} — ${g.label}`, "");
    if (env) {
      out.push(
        `ad4m commit \`${env.ad4mCommit ?? "?"}\`, Holochain ${env.runHolochain ? "on" : "off"}, ` +
          `${env.machine?.cpuCount} CPUs, ${env.machine?.totalRamGb} GB RAM.`,
        ""
      );
    }
    const skipped = g.runs.filter((r) => r.skipped);
    if (skipped.length) out.push(`Skipped runs: ${skipped.length} (${skipped[0].metrics?.skipReason ?? skipped[0].summary}).`, "");
    const failed = g.runs.filter((r) => !r.passed && !r.skipped);
    if (failed.length) out.push(`Failed runs: ${failed.length} — ${failed.map((r) => r.summary.slice(0, 200)).join(" | ")}`, "");
    out.push(
      "Runs: " +
        g.runs
          .map((r, i) => `#${i + 1} ${new Date(r.startTime).toISOString().slice(11, 16)}Z load ${r.environment?.loadAvgStart?.[0] ?? "?"} → ${r.environment?.loadAvgEnd?.[0] ?? "?"}`)
          .join("; "),
      ""
    );
    const per = g.runs.filter((r) => r.passed).map((r) => headlines(g.id, r.metrics));
    const keys = [...new Set(per.flatMap((h) => Object.keys(h)))];
    const rows = keys.map((k) => {
      const vals = per.map((h) => h[k]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const s = stats(vals);
      return { metric: k, ...s, values: vals };
    });
    json.push({ label: g.label, scenario: g.id, runs: g.runs.length, passed: per.length, environment: env, metrics: rows });
    if (rows.length) {
      out.push(
        mdTable(
          ["Metric", "n", "Mean", "Min", "Max", "Stddev", "Runs"],
          rows.map((r) => [r.metric, r.n, r.mean, r.min, r.max, r.stddev, r.values.map((v) => r2(v)).join(", ")])
        ),
        ""
      );
    }
  }
  return { markdown: out.join("\n"), json };
}

if (process.argv[1] && process.argv[1].endsWith("summarize.ts")) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: tsx src/platform/summarize.ts <results-dir>");
    process.exit(2);
  }
  const { markdown, json } = summarize(dir);
  writeFileSync(join(dir, "SUMMARY.md"), markdown);
  writeFileSync(join(dir, "SUMMARY.json"), JSON.stringify(json, null, 2));
  console.log(`[summarize] wrote ${join(dir, "SUMMARY.md")}`);
}

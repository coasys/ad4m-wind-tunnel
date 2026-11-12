/**
 * Shared machinery for the platform baseline scenarios (p1–p5): what one
 * hosted executor costs at idle, per space, on cold open and after removal.
 *
 * Every measurement reads /proc directly (RSS, VmSwap, threads, CPU ticks)
 * and covers the executor's child processes too.
 */

import { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { Dirent, existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { InstrumentedClient } from "../client.js";
import { startExecutor, waitForHealth, stopExecutorAndWait, sleep, ExecutorConfig } from "../executor.js";
import { ScenarioContext, ScenarioResult } from "../scenario.js";
import { serverLinkLanguageBundlePath } from "../convergence/languages.js";
import {
  descendantPids, procStatus, procComm, threadGroups, threadCpuSnapshot, threadPool,
  totalCpuTicks, ticksToPercent, hostCpuSnapshot, hostBusyPercent, loadAverage, smapsRollup,
  getExecutorPid, dirSizeBytes, ThreadGroup,
} from "../proc-metrics.js";

// ── Parameters ──

export function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name}="${v}" is not an integer`);
  return n;
}

export function envIntList(name: string, dflt: number[]): number[] {
  const v = process.env[name];
  if (!v) return dflt;
  const list = v.split(",").map((x) => parseInt(x.trim(), 10));
  if (list.some((n) => !Number.isFinite(n) || n < 0)) throw new Error(`${name}="${v}" is not a list of integers`);
  return list;
}

// ── Statistics ──

export interface Stats {
  n: number;
  mean: number;
  min: number;
  max: number;
  stddev: number;
  median: number;
}

export function stats(values: number[]): Stats {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return { n: 0, mean: NaN, min: NaN, max: NaN, stddev: NaN, median: NaN };
  const sorted = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.length > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1) : 0;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: v.length, mean, min: sorted[0], max: sorted[sorted.length - 1], stddev: Math.sqrt(variance), median };
}

export const r2 = (x: number) => Math.round(x * 100) / 100;
export const mb = (kb: number | null | undefined) => (kb == null ? NaN : r2(kb / 1024));

// ── Process sampling ──

export interface ProcSample {
  /** ms since the window started */
  tMs: number;
  rssKb: number;
  swapKb: number;
  threads: number;
  /** RSS of child processes (sum), kB */
  childRssKb: number;
  childCount: number;
  /** CPU % of one core since the previous sample (executor + children) */
  cpuPercent: number;
}

export interface ProcessSnapshot {
  pid: number;
  rssKb: number | null;
  hwmKb: number | null;
  swapKb: number | null;
  rssAnonKb: number | null;
  rssFileKb: number | null;
  threads: number | null;
  threadGroups: ThreadGroup[];
  children: Array<{ pid: number; comm: string | null; rssKb: number | null; swapKb: number | null; threads: number | null }>;
  smapsRollupKb: Record<string, number>;
}

/** Everything about the executor process at one instant. */
export function snapshotProcess(pid: number): ProcessSnapshot {
  const st = procStatus(pid);
  return {
    pid,
    rssKb: st?.vmRssKb ?? null,
    hwmKb: st?.vmHwmKb ?? null,
    swapKb: st?.vmSwapKb ?? null,
    rssAnonKb: st?.rssAnonKb ?? null,
    rssFileKb: st?.rssFileKb ?? null,
    threads: st?.threads ?? null,
    threadGroups: threadGroups(pid),
    children: descendantPids(pid).map((c) => {
      const cs = procStatus(c);
      return { pid: c, comm: procComm(c), rssKb: cs?.vmRssKb ?? null, swapKb: cs?.vmSwapKb ?? null, threads: cs?.threads ?? null };
    }),
    smapsRollupKb: smapsRollup(pid),
  };
}

export interface IdleWindowResult {
  settleSec: number;
  windowSec: number;
  sampleSec: number;
  /** CPU % of one core over the whole window, from the total tick delta (executor + children). */
  cpuPercent: number;
  /** Same, split by thread pool (executor threads only), largest first. */
  cpuByPool: Array<{ pool: string; threads: number; cpuPercent: number }>;
  cpuSampleStats: Stats;
  rssKb: { start: number; end: number; min: number; max: number; mean: number };
  swapKb: { start: number; end: number; max: number };
  threads: { start: number; end: number; max: number };
  childCount: number;
  /** Host CPU busy % (all cores) over the window — contention from other work on the box. */
  hostBusyPercent: number | null;
  loadAvgBefore: [number, number, number] | null;
  loadAvgAfter: [number, number, number] | null;
  start: ProcessSnapshot;
  end: ProcessSnapshot;
  samples: ProcSample[];
}

function poolTicks(pid: number): Map<string, { ticks: number; threads: number }> {
  const m = new Map<string, { ticks: number; threads: number }>();
  for (const t of threadCpuSnapshot(pid)) {
    const p = threadPool(t.name);
    const e = m.get(p) ?? { ticks: 0, threads: 0 };
    e.ticks += t.utime + t.stime;
    e.threads++;
    m.set(p, e);
  }
  return m;
}

/**
 * Wait `settleSec`, then sample for `windowSec` every `sampleSec`. Nothing
 * is sent to the executor during the window. CPU is the tick delta over
 * the whole window (exact), plus per-interval samples for the spread.
 */
export async function measureIdleWindow(
  pid: number,
  opts: { settleSec: number; windowSec: number; sampleSec: number; label?: string }
): Promise<IdleWindowResult> {
  const { settleSec, windowSec, sampleSec } = opts;
  if (settleSec > 0) {
    console.log(`[platform] ${opts.label ?? "idle"}: settle ${settleSec}s`);
    await sleep(settleSec * 1000);
  }
  console.log(`[platform] ${opts.label ?? "idle"}: idle window ${windowSec}s (sample every ${sampleSec}s)`);
  const pids = () => [pid, ...descendantPids(pid)];
  const loadAvgBefore = loadAverage();
  const host0 = hostCpuSnapshot();
  const start = snapshotProcess(pid);
  const pools0 = poolTicks(pid);
  const t0 = Date.now();
  const ticks0 = totalCpuTicks(pids());
  let prevTicks = ticks0;
  let prevT = t0;
  const samples: ProcSample[] = [];
  const deadline = t0 + windowSec * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.min(sampleSec * 1000, Math.max(0, deadline - Date.now())));
    const now = Date.now();
    const ps = pids();
    const ticks = totalCpuTicks(ps);
    const st = procStatus(pid);
    if (!st) throw new Error(`executor pid ${pid} exited during the idle window`);
    let childRss = 0;
    for (const c of ps.slice(1)) childRss += procStatus(c)?.vmRssKb ?? 0;
    samples.push({
      tMs: now - t0,
      rssKb: st.vmRssKb ?? 0,
      swapKb: st.vmSwapKb ?? 0,
      threads: st.threads ?? 0,
      childRssKb: childRss,
      childCount: ps.length - 1,
      cpuPercent: r2(ticksToPercent(ticks - prevTicks, now - prevT)),
    });
    prevTicks = ticks;
    prevT = now;
  }
  const t1 = Date.now();
  const ticks1 = totalCpuTicks(pids());
  const pools1 = poolTicks(pid);
  const host1 = hostCpuSnapshot();
  const end = snapshotProcess(pid);
  const windowMs = t1 - t0;

  const cpuByPool = [...pools1.entries()]
    .map(([pool, e]) => ({
      pool,
      threads: e.threads,
      cpuPercent: r2(ticksToPercent(e.ticks - (pools0.get(pool)?.ticks ?? 0), windowMs)),
    }))
    .sort((a, b) => b.cpuPercent - a.cpuPercent || b.threads - a.threads);

  const rss = samples.map((s) => s.rssKb);
  return {
    settleSec,
    windowSec,
    sampleSec,
    cpuPercent: r2(ticksToPercent(ticks1 - ticks0, windowMs)),
    cpuByPool,
    cpuSampleStats: stats(samples.map((s) => s.cpuPercent)),
    rssKb: {
      start: start.rssKb ?? 0,
      end: end.rssKb ?? 0,
      min: Math.min(...rss),
      max: Math.max(...rss),
      mean: Math.round(rss.reduce((a, b) => a + b, 0) / Math.max(1, rss.length)),
    },
    swapKb: { start: start.swapKb ?? 0, end: end.swapKb ?? 0, max: Math.max(0, ...samples.map((s) => s.swapKb)) },
    threads: { start: start.threads ?? 0, end: end.threads ?? 0, max: Math.max(0, ...samples.map((s) => s.threads)) },
    childCount: end.children.length,
    hostBusyPercent: host0 && host1 ? r2(hostBusyPercent(host0, host1)) : null,
    loadAvgBefore,
    loadAvgAfter: loadAverage(),
    start,
    end,
    samples,
  };
}

// ── Executors the scenario owns ──

export interface OwnedExecutor {
  proc: ChildProcess;
  pid: number;
  port: number;
  dataPath: string;
  client: InstrumentedClient;
  /** spawn → /health answers and the RPC socket replies */
  bootMs: number;
  /** `performance.now()` at spawn, for spawn → first answer timings. */
  spawnedAt: number;
}

/**
 * Start an executor the scenario owns (for restarts). Uses the same flags
 * the runner uses, including `--run-holochain`. `skipInit` keeps the data dir.
 */
export async function launchExecutor(
  ctx: ScenarioContext,
  opts: { port: number; dataPath: string; skipInit: boolean }
): Promise<OwnedExecutor> {
  if (!ctx.executorPath) throw new Error("no executor path in the scenario context");
  const cfg: ExecutorConfig = {
    branch: ctx.branch,
    port: opts.port,
    dataPath: opts.dataPath,
    adminToken: ctx.adminToken,
    adamRepoPath: ctx.adamRepoPath,
    buildDir: "",
    extraArgs: ctx.extraArgs && ctx.extraArgs.length > 0 ? ctx.extraArgs : undefined,
    runHolochain: ctx.runHolochain,
    skipInit: opts.skipInit,
  };
  const t0 = performance.now();
  const proc = await startExecutor(ctx.executorPath, cfg);
  try {
    // 25 ms polling: boot time is a headline number, so its resolution matters.
    await waitForHealth(opts.port, 180000, ctx.adminToken, 25);
  } catch (err) {
    await stopExecutorAndWait(proc);
    throw err;
  }
  const bootMs = performance.now() - t0;
  const client = new InstrumentedClient({ port: opts.port, adminToken: ctx.adminToken });
  const pid = proc.pid ?? getExecutorPid(opts.port);
  try {
    if (!pid) throw new Error("could not resolve the executor pid");
    await client.connect();
  } catch (err) {
    // Nothing owns the executor yet: stop it here or it outlives the scenario.
    try { await client.disconnect(); } catch {}
    await stopExecutorAndWait(proc);
    throw err;
  }
  return { proc, pid, port: opts.port, dataPath: opts.dataPath, client, bootMs, spawnedAt: t0 };
}

export async function stopOwned(e: OwnedExecutor | null): Promise<void> {
  if (!e) return;
  try { await e.client.disconnect(); } catch {}
  await stopExecutorAndWait(e.proc);
}

export const AGENT_PASSPHRASE = "wind-tunnel-test";

/**
 * Make the agent usable. A fresh data dir needs `agent.generate`; a
 * restarted one needs `agent.unlock` (with the same Holochain setting).
 * Returns the time the call took, or null when nothing was needed.
 */
export async function ensureAgent(e: OwnedExecutor, fresh: boolean, runHolochain: boolean | undefined): Promise<number | null> {
  const t0 = performance.now();
  if (fresh) {
    try {
      await e.client.call("agent.generate", { passphrase: AGENT_PASSPHRASE });
    } catch (err: any) {
      if (!String(err.message).includes("already")) throw new Error(`agent.generate: ${err.message}`);
    }
    return performance.now() - t0;
  }
  const info: any = await e.client.call("runtime.info", {});
  if (info?.isUnlocked) return null;
  await e.client.call("agent.unlock", { passphrase: AGENT_PASSPHRASE, holochain: runHolochain ?? true });
  return performance.now() - t0;
}

export interface UntilFound<T> {
  value: T;
  /** Calls that answered "Perspective … not found" before the one that worked. */
  notFoundAnswers: number;
  /** Time from the first call to the answer that worked. */
  totalMs: number;
}

/**
 * Calls `fn` until it does not fail with "Perspective … not found".
 *
 * The executor answers /health before it has opened the perspectives in its
 * database: `initialize_from_db` opens each one in its own background task
 * (ad4m rust-executor/src/perspectives/mod.rs). A query that arrives first
 * gets a 404 for a perspective that exists. The wait is part of the cost of a
 * cold open, so callers record `notFoundAnswers` and `totalMs`. Any other
 * error, or a 404 that lasts past `timeoutMs`, is thrown.
 */
export async function untilFound<T>(fn: () => Promise<T>, timeoutMs = 120_000, pollMs = 25): Promise<UntilFound<T>> {
  const t0 = performance.now();
  let notFoundAnswers = 0;
  for (;;) {
    try {
      const value = await fn();
      return { value, notFoundAnswers, totalMs: performance.now() - t0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Perspective \S+ not found/.test(msg) || performance.now() - t0 > timeoutMs) throw e;
      notFoundAnswers++;
      await sleep(pollMs);
    }
  }
}

/**
 * Runs `fn` on each item in order and returns the elapsed time of those calls
 * only, plus one error string per failed item. Read the time before any later
 * wait: P4 once read it after its idle window and reported 90 s for 20
 * language.remove calls that took under one second.
 */
export async function timedEach<T>(items: T[], fn: (item: T) => Promise<unknown>, label: (item: T) => string = String): Promise<{ ms: number; errors: string[] }> {
  const errors: string[] = [];
  const t0 = performance.now();
  for (const item of items) {
    try {
      const r: any = await fn(item);
      if (r && typeof r === "object" && r.error) errors.push(`${label(item)}: ${r.error}`);
    } catch (err) {
      errors.push(`${label(item)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ms: performance.now() - t0, errors };
}

/** Executor commit and version from `runtime.info`, for `result.environment`. */
export { executorIdentity } from "../run-environment.js";

/** Data dir for a scenario-owned executor (the runner does not start one for p-scenarios). */
export function ownedDataPath(ctx: ScenarioContext): string {
  return ctx.dataPath ?? join(ctx.tmpDirBase, "ad4m-wt-data-platform");
}

/** Remove a data dir the scenario created under the wind tunnel tmp dir. */
export function removeDataDir(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

// ── Spaces ──

export async function linkServerReachable(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3000) });
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, detail: err?.cause?.code || err?.message || String(err) };
  }
}

/** The link-server URL (`--link-server-url` is copied into LINK_SERVER_URL by the runner). */
export function linkServerUrl(): string {
  return process.env.LINK_SERVER_URL || "http://127.0.0.1:3456";
}

/**
 * Why neighbourhood scenarios cannot run, or null when they can: the
 * link-server must answer /health and the server link language bundle must exist.
 */
export async function neighbourhoodPrerequisites(): Promise<string | null> {
  const url = linkServerUrl();
  const reach = await linkServerReachable(url);
  if (!reach.ok) {
    return `link-server not reachable at ${url} (${reach.detail}). Start it: AD4M_REPO=<ad4m checkout> docker compose -f infra/docker-compose.link-server.yml up -d`;
  }
  const bundle = serverLinkLanguageBundlePath();
  if (!existsSync(bundle)) {
    return `server link language bundle missing at ${bundle}. Build it: (cd <ad4m>/bootstrap-languages/server-link-language && deno run --allow-all esbuild.ts)`;
  }
  return null;
}

/** Publish the server link language source once per executor; returns its hash. */
export async function publishServerLinkLanguage(client: InstrumentedClient): Promise<string> {
  const res = await client.publishLanguage(serverLinkLanguageBundlePath(), {
    name: "server-link-language",
    description: "wind tunnel platform baseline",
    possibleTemplateParams: ["SERVER_URL", "UID", "name"],
  });
  if (res.error || !res.data?.address) throw new Error(`language.publish: ${res.error ?? "no address"}`);
  return res.data.address as string;
}

export interface CreatedSpace {
  uuid: string;
  kind: "perspective" | "neighbourhood";
  url?: string;
  linkLanguage?: string;
  createMs: number;
  /** Failed `language.applyTemplate` attempts before success (remote language store errors). */
  templateRetries?: number;
}

/** A perspective with `links` links (bulk-added in batches). */
export async function createPerspectiveSpace(
  client: InstrumentedClient,
  name: string,
  links: number,
  batch = 500
): Promise<CreatedSpace> {
  const t0 = performance.now();
  const p = await client.createPerspective(name);
  const uuid = p.data?.uuid;
  if (!uuid) throw new Error(`perspective.create: ${p.error ?? "no uuid"}`);
  await addSyntheticLinks(client, uuid, name, links, batch);
  return { uuid, kind: "perspective", createMs: performance.now() - t0 };
}

const TEMPLATE_ATTEMPTS = 4;

/**
 * A neighbourhood on the server link language: perspective → template the
 * language with a fresh UID → publish. Each one gets its own templated
 * language, so its own language instance and sync loop.
 */
export async function createNeighbourhoodSpace(
  client: InstrumentedClient,
  sourceHash: string,
  name: string,
  links: number
): Promise<CreatedSpace> {
  const t0 = performance.now();
  const p = await client.createPerspective(name);
  const uuid = p.data?.uuid;
  if (!uuid) throw new Error(`perspective.create: ${p.error ?? "no uuid"}`);
  // applyTemplate publishes the templated bundle through the language-language,
  // which uploads to a remote store over the internet. Its transient 5xx
  // errors are retried a bounded number of times and counted.
  let tmpl = await client.applyTemplateAndPublish(sourceHash, JSON.stringify({ SERVER_URL: linkServerUrl(), UID: randomUUID(), name }));
  let templateRetries = 0;
  while ((tmpl.error || !tmpl.data?.address) && templateRetries < TEMPLATE_ATTEMPTS - 1) {
    templateRetries++;
    console.log(`[platform] applyTemplate failed (attempt ${templateRetries}): ${String(tmpl.error).slice(0, 160)}; retrying`);
    await sleep(2000 * templateRetries);
    tmpl = await client.applyTemplateAndPublish(sourceHash, JSON.stringify({ SERVER_URL: linkServerUrl(), UID: randomUUID(), name }));
  }
  if (tmpl.error || !tmpl.data?.address) throw new Error(`language.applyTemplate after ${templateRetries + 1} attempts: ${tmpl.error ?? "no address"}`);
  const nh = await client.publishNeighbourhood(uuid, tmpl.data.address, { links: [] });
  if (nh.error || !nh.data) throw new Error(`neighbourhood.publish: ${nh.error ?? "no url"}`);
  await addSyntheticLinks(client, uuid, name, links, 100);
  return { uuid, kind: "neighbourhood", url: String(nh.data), linkLanguage: tmpl.data.address, createMs: performance.now() - t0, templateRetries };
}

export async function addSyntheticLinks(
  client: InstrumentedClient,
  uuid: string,
  tag: string,
  count: number,
  batch = 500
): Promise<void> {
  for (let i = 0; i < count; i += batch) {
    const n = Math.min(batch, count - i);
    const links = Array.from({ length: n }, (_, k) => ({
      source: `ad4m://wt/${tag}/item-${Math.floor((i + k) / 10)}`,
      predicate: "ad4m://wt/has",
      target: `literal://string:${tag}-${i + k}`,
    }));
    const r = await client.addLinks(uuid, links);
    if (r.error) throw new Error(`perspective.addLinks (${i}/${count}): ${r.error}`);
  }
}

/** Size on disk of each perspective's Oxigraph/RocksDB store: `<data>/perspectives/<uuid>`. */
export interface StoreSize {
  /** Apparent size of `<data>/perspectives/<uuid>`, bytes. */
  bytes: number;
  /**
   * RocksDB write-ahead log (`*.log`) inside it. The executor does not flush
   * memtables on shutdown, so recent writes live only here until the next
   * open replays and flushes them. A size read right after writing is mostly WAL.
   */
  walBytes: number;
}

function walBytes(dir: string): number {
  let total = 0;
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += walBytes(p);
    else if (e.isFile() && e.name.endsWith(".log")) total += dirSizeBytes(p);
  }
  return total;
}

/** Size on disk of each perspective's Oxigraph/RocksDB store: `<data>/perspectives/<uuid>`. */
export function perspectiveStoreSizes(dataPath: string): Record<string, StoreSize> {
  const dir = join(dataPath, "perspectives");
  const out: Record<string, StoreSize> = {};
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) out[e] = { bytes: dirSizeBytes(join(dir, e)), walBytes: walBytes(join(dir, e)) };
  return out;
}

/** Sum of `perspectiveStoreSizes` over every store. */
export function totalStoreSize(dataPath: string): StoreSize {
  const t = { bytes: 0, walBytes: 0 };
  for (const s of Object.values(perspectiveStoreSizes(dataPath))) {
    t.bytes += s.bytes;
    t.walBytes += s.walBytes;
  }
  return t;
}

/** Size of every top-level entry of the data dir, bytes. */
export function dataDirBreakdown(dataPath: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!existsSync(dataPath)) return out;
  for (const e of readdirSync(dataPath)) out[e] = dirSizeBytes(join(dataPath, e));
  return out;
}

// ── Markdown ──

export function mdTable(header: string[], rows: Array<Array<string | number>>): string {
  const fmt = (v: string | number) => (typeof v === "number" ? (Number.isFinite(v) ? String(r2(v)) : "—") : v);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(fmt).join(" | ")} |`),
  ].join("\n");
}

export function threadGroupsMarkdown(groups: ThreadGroup[]): string {
  return mdTable(
    ["Thread pool", "Threads", "Raw names"],
    groups.map((g) => [g.pool, g.count, g.names.slice(0, 4).join(", ") + (g.names.length > 4 ? ", …" : "")])
  );
}

export function idleWindowMarkdown(w: IdleWindowResult, title: string): string {
  const la = (v: [number, number, number] | null) => (v ? v.map((x) => x.toFixed(2)).join(" / ") : "?");
  return [
    `### ${title}`,
    "",
    mdTable(["Metric", "Value"], [
      ["Idle window", `${w.windowSec} s after ${w.settleSec} s settle, sample every ${w.sampleSec} s`],
      ["CPU (% of one core, whole window, executor + children)", w.cpuPercent],
      ["CPU per-sample mean / min / max / stddev", `${r2(w.cpuSampleStats.mean)} / ${r2(w.cpuSampleStats.min)} / ${r2(w.cpuSampleStats.max)} / ${r2(w.cpuSampleStats.stddev)}`],
      ["RSS start / end / max (MB)", `${mb(w.rssKb.start)} / ${mb(w.rssKb.end)} / ${mb(w.rssKb.max)}`],
      ["RssAnon / RssFile at end (MB)", `${mb(w.end.rssAnonKb)} / ${mb(w.end.rssFileKb)}`],
      ["VmSwap start / end (MB)", `${mb(w.swapKb.start)} / ${mb(w.swapKb.end)}`],
      ["Threads start / end / max", `${w.threads.start} / ${w.threads.end} / ${w.threads.max}`],
      ["Child processes", w.childCount === 0 ? "none" : w.end.children.map((c) => `${c.comm}(${mb(c.rssKb)} MB, ${c.threads} thr)`).join(", ")],
      ["Host CPU busy over window (all cores)", `${w.hostBusyPercent}%`],
      ["Load average before / after", `${la(w.loadAvgBefore)} → ${la(w.loadAvgAfter)}`],
    ]),
    "",
    "CPU by thread pool over the window (top 10):",
    "",
    mdTable(["Pool", "Threads", "CPU %"], w.cpuByPool.slice(0, 10).map((p) => [p.pool, p.threads, p.cpuPercent])),
    "",
  ].join("\n");
}

/** Drop the big per-sample arrays and snapshots from an idle window for compact JSON summaries. */
export function idleSummary(w: IdleWindowResult) {
  return {
    cpuPercent: w.cpuPercent,
    rssMb: mb(w.rssKb.end),
    rssMeanMb: mb(w.rssKb.mean),
    swapMb: mb(w.swapKb.end),
    threads: w.threads.end,
    children: w.childCount,
    hostBusyPercent: w.hostBusyPercent,
  };
}

// ── Results ──

export function scenarioName(id: string, name: string): string {
  return `${id}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}`;
}

/** A result that measured nothing because a dependency was missing. */
export function skippedResult(
  id: string,
  name: string,
  ctx: ScenarioContext,
  startTime: number,
  reason: string,
  parameters: Record<string, unknown>
): ScenarioResult {
  const endTime = Date.now();
  return {
    scenario: scenarioName(id, name),
    branch: ctx.branch,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    passed: false,
    skipped: true,
    metrics: { skipped: true, skipReason: reason, parameters },
    samples: [],
    summary: `SKIPPED: ${reason}`,
    markdown: `# ${id} ${name}\n\n**Skipped.** ${reason}\n\nNothing was measured.\n`,
  };
}

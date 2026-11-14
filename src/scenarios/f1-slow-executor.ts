/**
 * F1: Slow Executor (fault injection) — does a slow executor tip into a
 * query pileup, and does it come back when the slowness ends?
 *
 * Production (staging, 30 Oct and 13 Nov 2026): during calls the shared
 * executor sat at 1,000–2,700% CPU with ~89 queries stuck. Suspected loop:
 * slow queries → client subscribe timeouts → re-subscribes → more live
 * queries re-running on every write → slower still.
 *
 * Shape (one space, WE-like):
 *  - setup: one perspective (or, with F1_NEIGHBOURHOOD=1, a neighbourhood on
 *    the server link language) with F1_LINKS links: channel messages and call
 *    transcript lines, two links each (has_child + body). Author and timestamp
 *    are the executor's own link metadata.
 *  - per fault level: restart the executor on that data inside its own
 *    systemd user scope; open F1_CLIENTS app clients (own socket each), each
 *    holding two live SPARQL queries (newest 50 channel messages, newest 50
 *    transcript lines, both ORDER BY timestamp) and paging older messages with
 *    a one-shot query every F1_PAGE_EVERY_SEC; F1_BOTS bot clients each hold an
 *    "everything" live query. F1_SPEAKERS speakers each write one transcript
 *    line per F1_WRITE_MS (open loop, like a live call); an auto-processor adds
 *    an interpretation link and removes the previous one every F1_AUTOPROC_MS.
 *  - phases: baseline F1_BASELINE_SEC → fault F1_FAULT_SEC (CPU quota of
 *    1/level of one core on the executor's cgroup) → recovery F1_RECOVERY_SEC.
 *
 * Measured every second: executor CPU (ticks of the executor and its
 * children), RSS, threads, SPARQL evaluations running (threads named
 * `ad4m-eval-watchdog`, one per running eval), subscriptions registered on
 * the executor (from its `🔗 subscription … created` / `… dropped` log lines,
 * an upper bound), live queries the clients hold, client calls in flight,
 * client timeouts and re-subscribes, cgroup throttled time. Per phase: query
 * latency p50/p99 (subscribe and page), write latency, write-to-visible (a
 * line's write sent → it shows in a client's transcript live query).
 *
 * Client behaviour: F1_CLIENT_MODE=sdk (default) mirrors the SDK at ad4m dev
 * (request.cancel + dispose on a timed-out subscribe, re-open with backoff);
 * `legacy` is a client from before #1680/#1685 (no cancel, no dispose,
 * immediate re-subscribe). See src/fault/live-client.ts.
 *
 * Tunables (env, defaults shown):
 *   F1_LINKS 30000  F1_CLIENTS 10  F1_BOTS 1  F1_SPEAKERS 4  F1_WRITE_MS 1000
 *   F1_AUTOPROC_MS 2000  F1_PAGE_EVERY_SEC 10  F1_TIMEOUT_MS 30000
 *   F1_LEVELS 1,4,20,100  F1_BASELINE_SEC 60  F1_FAULT_SEC 120  F1_RECOVERY_SEC 180
 *   F1_SETTLE_SEC 20  F1_CLIENT_MODE sdk  F1_BOT_QUERY links|all  F1_NEIGHBOURHOOD 0
 *   F1_EXEC_MEMORY_MAX 24G
 */

import { ChildProcess } from "child_process";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";
import {
  envInt, launchExecutor, stopOwned, ensureAgent, executorIdentity, ownedDataPath, removeDataDir,
  untilFound, scenarioName, mdTable, mb, r2, OwnedExecutor, neighbourhoodPrerequisites,
  publishServerLinkLanguage, createNeighbourhoodSpace,
} from "../platform/common.js";
import { descendantPids, procStatus, threadCpuSnapshot, totalCpuTicks, ticksToPercent, loadAverage } from "../proc-metrics.js";
import {
  FaultSample, Phase, classifyPileup, recoveryTime, percentile, countLogLine, emptyLogCounts, splitLines,
  quotaPercentForSlowdown, parseLevels, LogCounts, backlog,
} from "../fault/analysis.js";
import { scopeLauncher, scopeUnitName, scopeSupported, cgroupPathOf, setCpuQuota, readCpuStat, readCpuMax } from "../fault/cgroup.js";
import { RpcSocket, LiveSub, RunCounters, ClientMode, liveLineIds } from "../fault/live-client.js";

const ID = "f1";
const NAME = "Slow Executor";

const NS = "ad4m://wt/f1";
const CHANNEL = `${NS}/channel`;
const CALL = `${NS}/call`;
const HAS_CHILD = "ad4m://has_child";
const BODY = "flux://body";
const INTERP = `${NS}/interpretation`;
const REIFIES = "http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies";

/** Newest `limit` children of `parent` by link timestamp, with author and body: a WE feed page. */
export function feedQuery(parent: string, limit: number, offset = 0): string {
  return [
    "SELECT ?item ?ts ?author ?body WHERE {",
    `  ?r <${REIFIES}> <<( <${parent}> <${HAS_CHILD}> ?item )>> ;`,
    "     <ad4m://ontology/timestamp> ?ts ;",
    "     <ad4m://ontology/author> ?author .",
    `  OPTIONAL { ?item <${BODY}> ?body }`,
    `} ORDER BY DESC(?ts) LIMIT ${limit}${offset > 0 ? ` OFFSET ${offset}` : ""}`,
  ].join("\n");
}

/** A bot's "everything" query: every link with its timestamp, or every quad. */
export function everythingQuery(kind: string): string {
  return kind === "all"
    ? "SELECT ?s ?p ?o WHERE { ?s ?p ?o }"
    : `SELECT ?s ?p ?o ?ts WHERE { ?r <${REIFIES}> <<( ?s ?p ?o )>> ; <ad4m://ontology/timestamp> ?ts }`;
}

function lit(text: string): string {
  return `literal://string:${encodeURIComponent(text)}`;
}

/** Seed links: 2/3 of them channel messages, 1/3 transcript lines, two links each. */
export function seedLinks(total: number): Array<{ source: string; predicate: string; target: string }> {
  const messages = Math.floor(total / 3);
  const lines = Math.floor((total - 2 * messages) / 2);
  const out: Array<{ source: string; predicate: string; target: string }> = [];
  for (let i = 0; i < messages; i++) {
    const m = `${NS}/msg/${i}`;
    out.push({ source: CHANNEL, predicate: HAS_CHILD, target: m });
    out.push({ source: m, predicate: BODY, target: lit(`message ${i}: ${"lorem ipsum dolor sit amet ".repeat(3)}`) });
  }
  for (let i = 0; i < lines; i++) {
    const l = `${NS}/line/seed-${i}`;
    out.push({ source: CALL, predicate: HAS_CHILD, target: l });
    out.push({ source: l, predicate: BODY, target: lit(`speaker ${i % 4}: transcript line ${i} ${"words spoken in the call ".repeat(2)}`) });
  }
  return out;
}

interface Params {
  links: number; clients: number; bots: number; speakers: number; writeMs: number; autoprocMs: number;
  pageEverySec: number; timeoutMs: number; levels: number[]; baselineSec: number; faultSec: number;
  recoverySec: number; settleSec: number; clientMode: ClientMode; botQuery: string; neighbourhood: boolean;
  execMemoryMax: string; runHolochain: boolean; churnSec: number;
}

function readParams(ctx: ScenarioContext): Params {
  const mode = (process.env.F1_CLIENT_MODE || "sdk") as ClientMode;
  if (mode !== "sdk" && mode !== "legacy") throw new Error(`F1_CLIENT_MODE must be sdk or legacy, not ${mode}`);
  return {
    links: envInt("F1_LINKS", 30000),
    clients: envInt("F1_CLIENTS", 10),
    bots: envInt("F1_BOTS", 1),
    speakers: envInt("F1_SPEAKERS", 4),
    writeMs: envInt("F1_WRITE_MS", 1000),
    autoprocMs: envInt("F1_AUTOPROC_MS", 2000),
    pageEverySec: envInt("F1_PAGE_EVERY_SEC", 10),
    timeoutMs: envInt("F1_TIMEOUT_MS", 30000),
    levels: parseLevels(process.env.F1_LEVELS, [1, 4, 20, 100]),
    baselineSec: envInt("F1_BASELINE_SEC", 60),
    faultSec: envInt("F1_FAULT_SEC", 120),
    recoverySec: envInt("F1_RECOVERY_SEC", 180),
    settleSec: envInt("F1_SETTLE_SEC", 20),
    clientMode: mode,
    botQuery: process.env.F1_BOT_QUERY || "links",
    neighbourhood: process.env.F1_NEIGHBOURHOOD === "1",
    execMemoryMax: process.env.F1_EXEC_MEMORY_MAX || "24G",
    churnSec: envInt("F1_CHURN_SEC", 0),
    runHolochain: ctx.runHolochain ?? true,
  };
}

/** Follow the executor's output and count subscription log lines. */
function followLogs(proc: ChildProcess, counts: LogCounts): void {
  for (const stream of [proc.stdout, proc.stderr]) {
    let carry = "";
    stream?.on("data", (d: Buffer) => {
      const r = splitLines(carry, d.toString());
      carry = r.carry;
      for (const l of r.lines) countLogLine(l, counts);
    });
  }
}

function evalThreads(pid: number): number {
  return threadCpuSnapshot(pid).filter((t) => t.name.startsWith("ad4m-eval-watch")).length;
}

interface PhaseStats {
  subscribe: { n: number; p50: number; p99: number; timeouts: number; errors: number };
  page: { n: number; p50: number; p99: number; timeouts: number; errors: number };
  write: { n: number; p50: number; p99: number; timeouts: number; errors: number };
  visible: { n: number; p50: number; p99: number };
  writesSent: number;
}

function callStats(calls: RunCounters["calls"], match: (m: string) => boolean, from: number, to: number) {
  const c = calls.filter((x) => match(x.method) && x.doneAt >= from && x.doneAt < to);
  const ms = c.map((x) => x.ms);
  return {
    n: c.length,
    p50: r2(percentile(ms, 0.5)),
    p99: r2(percentile(ms, 0.99)),
    timeouts: c.filter((x) => x.outcome === "timeout").length,
    errors: c.filter((x) => x.outcome === "error").length,
  };
}

interface LevelResult {
  level: number;
  quotaPercent: number | null;
  cpuMaxDuringFault: string | null;
  loadAvgAtStart: [number, number, number] | null;
  bootMs: number;
  openMs: number;
  initialSubscribeMs: number;
  phases: Record<Phase, PhaseStats>;
  verdict: ReturnType<typeof classifyPileup>;
  recovery: ReturnType<typeof recoveryTime>;
  peaks: Record<Phase, { cpuPercent: number; rssMb: number; threads: number; evalThreads: number; executorSubs: number; clientInflight: number; backlog: number }>;
  totals: { timeouts: number; resubscribes: number; resyncs: number; lagged: number; errors: number; logCreated: number; logDropped: number; deadlineStops: number; throttledMs: number; churnOpens: number; subCancels: number };
  /** Client calls recorded in this level (any method, any outcome). */
  callsRecorded: number;
  samples: FaultSample[];
  error?: string;
}

async function runLevel(ctx: ScenarioContext, p: Params, dataPath: string, uuid: string, level: number): Promise<LevelResult> {
  const unit = scopeUnitName(`l${level}`);
  const logCounts = emptyLogCounts();
  const loadAvgAtStart = loadAverage();
  console.log(`[f1] level ${level}×: load ${loadAvgAtStart?.join(" ")}; starting executor in scope ${unit}`);
  const exec = await launchExecutor(ctx, { port: ctx.port, dataPath, skipInit: true, launcher: scopeLauncher(unit, p.execMemoryMax) });
  followLogs(exec.proc, logCounts);
  const counters = new RunCounters();
  const sockets: RpcSocket[] = [];
  const subs: LiveSub[] = [];
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  try {
    await ensureAgent(exec, false, p.runHolochain);
    const opened = await untilFound(async () => {
      const r = await exec.client.queryLinks(uuid, { limit: 1 });
      if (r.error) throw new Error(r.error);
      return r;
    });
    const cgroup = cgroupPathOf(exec.pid);
    if (!cgroup) throw new Error(`no cgroup for executor pid ${exec.pid}`);
    setCpuQuota(unit, cgroup, null);

    const url = `ws://127.0.0.1:${ctx.port}/api/v1/ws?token=${ctx.adminToken}`;
    const newSocket = async () => {
      const s = new RpcSocket(url, p.clientMode, counters, p.timeoutMs);
      await s.connect();
      sockets.push(s);
      return s;
    };

    // Writers: speakers (open loop) and the auto-processor (closed loop).
    const writer = await newSocket();
    const sentAt = new Map<number, number>();
    let lineSeq = Date.now() % 1_000_000_000; // unique across levels on the same data
    const t0 = Date.now();
    const startWriters = () => {
      for (let s = 0; s < p.speakers; s++) {
        const t = setInterval(() => {
          if (stopped) return;
          const n = ++lineSeq;
          const line = `${NS}/line/live-${n}`;
          sentAt.set(n, Date.now());
          writer
            .call("perspective.addLinks", {
              uuid,
              links: [
                { source: CALL, predicate: HAS_CHILD, target: line },
                { source: line, predicate: BODY, target: lit(`speaker ${s}: live line ${n}`) },
              ],
            })
            .catch(() => {});
        }, p.writeMs);
        timers.push(t);
      }
      let prev: any = null;
      const autoproc = async () => {
        while (!stopped) {
          const started = Date.now();
          try {
            const r: any = await writer.call("perspective.addLink", {
              uuid,
              link: { source: `${NS}/line/live-${lineSeq}`, predicate: INTERP, target: lit(`interpretation ${started}`) },
            });
            if (prev) await writer.call("perspective.removeLink", { uuid, link: prev }).catch(() => {});
            prev = r ?? null;
          } catch {}
          const wait = p.autoprocMs - (Date.now() - started);
          if (wait > 0) await sleep(wait);
        }
      };
      void autoproc();
    };

    // App clients and bots.
    let churnArmed = false;
    let churnOpens = 0;
    const tSub0 = Date.now();
    for (let c = 0; c < p.clients; c++) {
      const sock = await newSocket();
      const seen = new Set<number>();
      const onTranscript = (rows: unknown) => {
        const now = Date.now();
        for (const id of liveLineIds(rows)) {
          if (seen.has(id)) continue;
          seen.add(id);
          const at = sentAt.get(id);
          if (at !== undefined) counters.visible.push({ at: now, ms: now - at });
        }
      };
      let feed = new LiveSub(sock, uuid, feedQuery(CHANNEL, 50), p.clientMode, counters);
      const transcript = new LiveSub(sock, uuid, feedQuery(CALL, 50), p.clientMode, counters, onTranscript);
      subs.push(feed, transcript);
      feed.start();
      transcript.start();
      if (p.churnSec > 0) {
        // A user switching channel and back: close the feed live query and open a new one.
        const churnTimer = setInterval(() => {
          if (stopped || !churnArmed) return;
          feed.dispose();
          feed = new LiveSub(sock, uuid, feedQuery(CHANNEL, 50), p.clientMode, counters);
          subs.push(feed);
          churnOpens++;
          feed.start();
        }, p.churnSec * 1000 + Math.floor(Math.random() * 1000));
        timers.push(churnTimer);
      }
      const pageTimer = setInterval(() => {
        if (stopped) return;
        const offset = 50 + Math.floor(Math.random() * 2000);
        sock.call("perspective.querySparql", { uuid, engine: "sparql", query: feedQuery(CHANNEL, 50, offset) }).catch(() => {});
      }, p.pageEverySec * 1000 + Math.floor(Math.random() * 1000));
      timers.push(pageTimer);
    }
    for (let b = 0; b < p.bots; b++) {
      const sock = await newSocket();
      const bot = new LiveSub(sock, uuid, everythingQuery(p.botQuery), p.clientMode, counters);
      subs.push(bot);
      bot.start();
    }
    // Wait for the first results (or the settle time), then start the call.
    const want = subs.length;
    const subDeadline = Date.now() + Math.max(p.settleSec * 1000, p.timeoutMs + 5000);
    while (counters.liveSubs < want && Date.now() < subDeadline) await sleep(100);
    const initialSubscribeMs = Date.now() - tSub0;
    startWriters();
    churnArmed = true;
    await sleep(p.settleSec * 1000);
    counters.calls.length = 0;
    counters.visible.length = 0;

    // Sampling.
    const samples: FaultSample[] = [];
    const tStart = Date.now();
    const bounds = {
      faultStart: tStart + p.baselineSec * 1000,
      faultEnd: tStart + (p.baselineSec + p.faultSec) * 1000,
      end: tStart + (p.baselineSec + p.faultSec + p.recoverySec) * 1000,
    };
    const pids = () => [exec.pid, ...descendantPids(exec.pid)];
    let prevTicks = totalCpuTicks(pids());
    let prevT = Date.now();
    const throttled0 = readCpuStat(cgroup)?.throttledUsec ?? 0;
    let phase: Phase = "baseline";
    let cpuMaxDuringFault: string | null = null;
    const quota = quotaPercentForSlowdown(level);
    console.log(`[f1] level ${level}×: baseline ${p.baselineSec}s, fault ${p.faultSec}s (quota ${quota ?? "none"}%), recovery ${p.recoverySec}s`);
    while (Date.now() < bounds.end) {
      await sleep(1000 - ((Date.now() - tStart) % 1000));
      const now = Date.now();
      if (phase === "baseline" && now >= bounds.faultStart) {
        phase = "fault";
        if (quota != null) cpuMaxDuringFault = setCpuQuota(unit, cgroup, quota);
        console.log(`[f1] level ${level}×: fault on (cpu.max ${cpuMaxDuringFault ?? readCpuMax(cgroup)})`);
      } else if (phase === "fault" && now >= bounds.faultEnd) {
        phase = "recovery";
        setCpuQuota(unit, cgroup, null);
        console.log(`[f1] level ${level}×: fault off (cpu.max ${readCpuMax(cgroup)})`);
      }
      const ps = pids();
      const ticks = totalCpuTicks(ps);
      const st = procStatus(exec.pid);
      if (!st) throw new Error(`executor exited during level ${level}`);
      const s: FaultSample = {
        tMs: now - tStart,
        phase,
        cpuPercent: r2(ticksToPercent(ticks - prevTicks, now - prevT)),
        rssKb: st.vmRssKb ?? 0,
        threads: st.threads ?? 0,
        evalThreads: evalThreads(exec.pid),
        executorSubs: logCounts.created - logCounts.dropped,
        clientLiveSubs: counters.liveSubs,
        clientInflight: counters.inflight,
        timeouts: counters.timeouts,
        resubscribes: counters.resubscribes,
        throttledMs: Math.round(((readCpuStat(cgroup)?.throttledUsec ?? 0) - throttled0) / 1000),
        subCancels: counters.subCancels,
      };
      samples.push(s);
      prevTicks = ticks;
      prevT = now;
      if (samples.length % 15 === 0) {
        console.log(`[f1] ${level}× t=${Math.round(s.tMs / 1000)}s ${phase}: cpu ${s.cpuPercent}% rss ${mb(s.rssKb)}MB evals ${s.evalThreads} execSubs ${s.executorSubs} live ${s.clientLiveSubs} inflight ${s.clientInflight} timeouts ${s.timeouts} resubs ${s.resubscribes}`);
      }
    }
    stopped = true;

    const isSub = (m: string) => m === "perspective.subscribeQuery";
    const isPage = (m: string) => m === "perspective.querySparql";
    const isWrite = (m: string) => m === "perspective.addLinks" || m === "perspective.addLink" || m === "perspective.removeLink";
    const range: Record<Phase, [number, number]> = {
      baseline: [tStart, bounds.faultStart],
      fault: [bounds.faultStart, bounds.faultEnd],
      recovery: [bounds.faultEnd, bounds.end + 1],
    };
    const phases = {} as Record<Phase, PhaseStats>;
    const peaks = {} as LevelResult["peaks"];
    for (const ph of ["baseline", "fault", "recovery"] as Phase[]) {
      const [a, b] = range[ph];
      const vis = counters.visible.filter((v) => v.at >= a && v.at < b).map((v) => v.ms);
      phases[ph] = {
        subscribe: callStats(counters.calls, isSub, a, b),
        page: callStats(counters.calls, isPage, a, b),
        write: callStats(counters.calls, isWrite, a, b),
        visible: { n: vis.length, p50: r2(percentile(vis, 0.5)), p99: r2(percentile(vis, 0.99)) },
        writesSent: [...sentAt.values()].filter((t) => t >= a && t < b).length,
      };
      const ss = samples.filter((x) => x.phase === ph);
      const max = (f: (x: FaultSample) => number) => (ss.length ? Math.max(...ss.map(f)) : NaN);
      peaks[ph] = {
        cpuPercent: max((x) => x.cpuPercent),
        rssMb: mb(max((x) => x.rssKb)),
        threads: max((x) => x.threads),
        evalThreads: max((x) => x.evalThreads),
        executorSubs: max((x) => x.executorSubs),
        clientInflight: max((x) => x.clientInflight),
        backlog: max(backlog),
      };
    }
    const last = samples[samples.length - 1];
    return {
      level,
      quotaPercent: quota,
      cpuMaxDuringFault,
      loadAvgAtStart,
      bootMs: Math.round(exec.bootMs),
      openMs: Math.round(opened.totalMs),
      initialSubscribeMs,
      phases,
      verdict: classifyPileup(samples),
      recovery: recoveryTime(samples),
      peaks,
      totals: {
        timeouts: counters.timeouts,
        resubscribes: counters.resubscribes,
        resyncs: counters.resyncs,
        lagged: counters.lagged,
        errors: counters.errors,
        logCreated: logCounts.created,
        logDropped: logCounts.dropped,
        deadlineStops: logCounts.deadlineStops,
        throttledMs: last?.throttledMs ?? 0,
        churnOpens,
        subCancels: counters.subCancels,
      },
      callsRecorded: counters.calls.length,
      samples,
    };
  } finally {
    stopped = true;
    for (const t of timers) clearInterval(t);
    for (const s of subs) s.dispose();
    await sleep(200);
    for (const s of sockets) s.close();
    await stopOwned(exec);
  }
}

function levelMarkdown(r: LevelResult): string {
  const f = (v: number) => (Number.isFinite(v) ? String(Math.round(v)) : "—");
  const ph = (k: Phase) => r.phases[k];
  return [
    `### ${r.level}× slower (CPU quota ${r.quotaPercent == null ? "none" : `${r.quotaPercent}% of one core`}, cpu.max during fault: ${r.cpuMaxDuringFault ?? "unbounded"})`,
    "",
    `Load at start: ${r.loadAvgAtStart?.join(" / ") ?? "?"}. Boot ${r.bootMs} ms, perspective answered ${r.openMs} ms after, initial subscribes ${r.initialSubscribeMs} ms.`,
    "",
    `**Pileup: ${r.verdict.pileup ? "YES" : "no"}** — ${r.verdict.reason}. **Recovery:** ${r.recovery.recovered ? `${Math.round((r.recovery.recoveryMs ?? 0) / 1000)} s after the fault ended` : "not within the recovery window"}.`,
    "",
    mdTable(
      ["Phase", "Peak CPU %", "Peak RSS MB", "Peak threads", "Peak evals running", "Peak executor subs", "Peak client calls in flight", "Subscribe p50/p99 ms (n, timeouts)", "Page query p50/p99 ms (n, timeouts)", "Write p50/p99 ms (n, timeouts)", "Write→visible p50/p99 ms (n / lines sent)"],
      (["baseline", "fault", "recovery"] as Phase[]).map((k) => [
        k,
        r.peaks[k].cpuPercent,
        r.peaks[k].rssMb,
        r.peaks[k].threads,
        r.peaks[k].evalThreads,
        r.peaks[k].executorSubs,
        r.peaks[k].clientInflight,
        `${f(ph(k).subscribe.p50)} / ${f(ph(k).subscribe.p99)} (${ph(k).subscribe.n}, ${ph(k).subscribe.timeouts})`,
        `${f(ph(k).page.p50)} / ${f(ph(k).page.p99)} (${ph(k).page.n}, ${ph(k).page.timeouts})`,
        `${f(ph(k).write.p50)} / ${f(ph(k).write.p99)} (${ph(k).write.n}, ${ph(k).write.timeouts})`,
        `${f(ph(k).visible.p50)} / ${f(ph(k).visible.p99)} (${ph(k).visible.n} / ${ph(k).writesSent})`,
      ])
    ),
    "",
    `Totals: ${r.totals.timeouts} client timeouts, ${r.totals.resubscribes} re-subscribes, ${r.totals.churnOpens} channel-switch re-opens, ${r.totals.resyncs} resyncs, ${r.totals.lagged} lagged notices, ${r.totals.errors} error replies; executor log: ${r.totals.logCreated} subscriptions created, ${r.totals.logDropped} dropped, ${r.totals.subCancels} subscribes cancelled by the client (each removed without a log line); cgroup throttled ${Math.round(r.totals.throttledMs / 1000)} s.`,
    "",
  ].join("\n");
}

export const f1SlowExecutor: Scenario = {
  id: ID,
  name: NAME,
  description: "Fault injection: CPU-quota the executor at several slowdowns under WE-shaped live queries and call writes; pileup and recovery",
  managesOwnEnvironment: true,

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const startTime = Date.now();
    const p = readParams(ctx);
    const scope = scopeSupported();
    const base = { scenario: scenarioName(ID, NAME), branch: ctx.branch, samples: [] as ScenarioResult["samples"] };
    if (!scope.ok) {
      const endTime = Date.now();
      return { ...base, startTime, endTime, durationMs: endTime - startTime, passed: true, skipped: true, metrics: { parameters: p, skipReason: scope.detail }, summary: `skipped: ${scope.detail}` };
    }
    let nhNote = "perspective (no neighbourhood)";
    if (p.neighbourhood) {
      const why = await neighbourhoodPrerequisites();
      if (why) {
        const endTime = Date.now();
        return { ...base, startTime, endTime, durationMs: endTime - startTime, passed: true, skipped: true, metrics: { parameters: p, skipReason: why }, summary: `skipped: ${why}` };
      }
    }
    const dataPath = ownedDataPath(ctx);
    let setupExec: OwnedExecutor | null = null;
    const levels: LevelResult[] = [];
    let identity: any = {};
    let setup: Record<string, number> = {};
    try {
      // ── Setup: one space with the seed links ──
      setupExec = await launchExecutor(ctx, { port: ctx.port, dataPath, skipInit: false });
      await ensureAgent(setupExec, true, p.runHolochain);
      identity = await executorIdentity(setupExec.client);
      const t0 = performance.now();
      let uuid: string;
      if (p.neighbourhood) {
        const hash = await publishServerLinkLanguage(setupExec.client);
        const sp = await createNeighbourhoodSpace(setupExec.client, hash, "f1-space", 0);
        uuid = sp.uuid;
        nhNote = `neighbourhood on the server link language (${sp.url})`;
      } else {
        const r = await setupExec.client.createPerspective("f1-space");
        if (r.error || !r.data?.uuid) throw new Error(`perspective.create: ${r.error}`);
        uuid = r.data.uuid;
      }
      const links = seedLinks(p.links);
      for (let i = 0; i < links.length; i += 500) {
        const r = await setupExec.client.addLinks(uuid, links.slice(i, i + 500));
        if (r.error) throw new Error(`perspective.addLinks at ${i}: ${r.error}`);
      }
      setup = { seedLinks: links.length, seedMs: Math.round(performance.now() - t0) };
      console.log(`[f1] seeded ${links.length} links in ${setup.seedMs} ms (${nhNote})`);
      await stopOwned(setupExec);
      setupExec = null;

      for (const level of p.levels) {
        try {
          levels.push(await runLevel(ctx, p, dataPath, uuid, level));
        } catch (err: any) {
          console.error(`[f1] level ${level} failed: ${err?.message ?? err}`);
          levels.push({ level, error: String(err?.message ?? err) } as LevelResult);
        }
      }
    } finally {
      await stopOwned(setupExec);
      removeDataDir(dataPath);
    }

    const ok = levels.filter((l) => !l.error);
    const tipping = ok.find((l) => l.verdict.pileup);
    const summary = ok.length === 0
      ? "no level completed"
      : tipping
        ? `pileup from ${tipping.level}× slower; ${ok.map((l) => `${l.level}×: ${l.verdict.pileup ? "pileup" : "no pileup"}, recovery ${l.recovery.recovered ? `${Math.round((l.recovery.recoveryMs ?? 0) / 1000)}s` : "none"}`).join("; ")}`
        : `no pileup at any level (${ok.map((l) => `${l.level}×`).join(", ")}); recovery ${ok.map((l) => (l.recovery.recovered ? `${Math.round((l.recovery.recoveryMs ?? 0) / 1000)}s` : "none")).join(", ")}`;
    const markdown = [
      `# F1: ${NAME}`,
      "",
      `Executor ${identity?.ad4mCommit ?? "?"} (${identity?.ad4mExecutorVersion ?? "?"}), Holochain ${p.runHolochain ? "on" : "off"}. Space: ${nhNote}, ${p.links} seed links.`,
      `Clients: ${p.clients} app clients (2 live queries + a page query every ${p.pageEverySec}s each), ${p.bots} bot(s) with an "everything" query (${p.botQuery}); client mode **${p.clientMode}**, call timeout ${p.timeoutMs} ms.`,
      `Writes: ${p.speakers} speakers × 1 line / ${p.writeMs} ms; auto-processor add+remove every ${p.autoprocMs} ms.`,
      `Channel switching: ${p.churnSec > 0 ? `each client closes and re-opens its feed live query every ~${p.churnSec}s` : "off (live queries open once)"}.`,
      `Phases: baseline ${p.baselineSec}s → fault ${p.faultSec}s → recovery ${p.recoverySec}s. Slowdown N× = CPU quota of 1/N of one core on the executor's cgroup.`,
      "",
      `**Summary:** ${summary}`,
      "",
      mdTable(
        ["Slowdown", "Pileup", "Peak CPU % (fault / recovery)", "Peak evals running", "Peak executor subs", "Peak client calls in flight", "Timeouts", "Re-subscribes", "Recovery"],
        ok.map((l) => [
          `${l.level}×`,
          l.verdict.pileup ? "yes" : "no",
          `${l.peaks.fault.cpuPercent} / ${l.peaks.recovery.cpuPercent}`,
          Math.max(l.peaks.fault.evalThreads, l.peaks.recovery.evalThreads),
          Math.max(l.peaks.fault.executorSubs, l.peaks.recovery.executorSubs),
          Math.max(l.peaks.fault.clientInflight, l.peaks.recovery.clientInflight),
          l.totals.timeouts,
          l.totals.resubscribes,
          l.recovery.recovered ? `${Math.round((l.recovery.recoveryMs ?? 0) / 1000)} s` : "not recovered",
        ])
      ),
      "",
      ...levels.filter((l) => l.error).map((l) => `Level ${l.level}× failed: ${l.error}\n`),
      ...ok.map(levelMarkdown),
      "Live subscriptions on the executor come from its log (created − dropped), an upper bound: a subscribe that fails or is cancelled before it registers logs nothing. Evaluations running = threads named `ad4m-eval-watchdog` (one per running SPARQL evaluation).",
      "",
    ].join("\n");
    const endTime = Date.now();
    return {
      ...base,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      passed: ok.length === p.levels.length,
      metrics: { parameters: p, identity, setup, levels },
      summary,
      markdown,
    };
  },
};

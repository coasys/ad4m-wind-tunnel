/**
 * Process metrics utilities — shared across scenarios.
 *
 * Consolidates the `getRssKb`/`getExecutorPid` helpers duplicated across 11
 * scenario files (s2b, s3, s4, s7, s9, s10, s12, s14, s15, m4, m5) and adds
 * CPU measurement via `/proc/PID/stat` — instantaneous CPU%, not the
 * lifetime average `ps -o %cpu=` reports.
 *
 * PID namespaces: the wind tunnel starts the AD4M executor as a direct host
 * process (see executor.ts), so PIDs resolved via `lsof`/`ps` are already
 * host PIDs and `/proc/<pid>/stat` reads work unmodified. If a scenario ever
 * targets a containerized executor, the PID passed in must still be the
 * HOST-visible PID (e.g. from `docker inspect --format '{{.State.Pid}}'`),
 * not the PID as seen inside the container's own PID namespace — the host
 * kernel's `/proc` only understands host PIDs.
 */

import { execSync } from "child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "fs";

/**
 * Clock ticks per second on Linux (`getconf CLK_TCK`) — 100 on every
 * mainstream distro/kernel combination this harness targets.
 */
const CLK_TCK = 100;

/** Resolve the first PID listening on a port. */
export function getExecutorPid(port: number): number | null {
  try {
    const out = execSync(`lsof -ti :${port} 2>/dev/null || true`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (!out) return null;
    const n = parseInt(out.split("\n")[0], 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Read current RSS in kilobytes from `ps`. */
export function getRssKb(pid: number): number | null {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8", timeout: 5000 });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** `utime` + `stime` (in clock ticks) plus the wall-clock time of capture. */
export interface ProcCpuSnapshot {
  utime: number;
  stime: number;
  /** `Date.now()` at capture time. */
  clockMs: number;
}

/** Per-thread CPU snapshot from `/proc/PID/task/TID/stat`. */
export interface ThreadCpuSnapshot {
  tid: number;
  name: string;
  utime: number;
  stime: number;
}

interface RawStatCpu {
  name: string;
  utime: number;
  stime: number;
}

/**
 * Parse `utime`/`stime`/`comm` out of a `/proc/.../stat` line.
 *
 * The comm field (2nd, in parentheses) can itself contain spaces or
 * parentheses, so it's located by the LAST `)` on the line rather than by
 * splitting naively on spaces. Everything after that closing paren is
 * space-separated starting at `state` (original field 3): `utime` is field
 * 14 (index 11 in the post-comm array), `stime` is field 15 (index 12).
 * See `man 5 proc`.
 */
function parseStatCpu(statPath: string): RawStatCpu | null {
  try {
    if (!existsSync(statPath)) return null;
    const raw = readFileSync(statPath, "utf8").trim();
    const commStart = raw.indexOf("(");
    const commEnd = raw.lastIndexOf(")");
    if (commStart < 0 || commEnd <= commStart) return null;
    const name = raw.substring(commStart + 1, commEnd);
    const fields = raw.substring(commEnd + 2).split(" ");
    const utime = parseInt(fields[11], 10);
    const stime = parseInt(fields[12], 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return { name, utime, stime };
  } catch {
    return null;
  }
}

/**
 * Snapshot CPU ticks from `/proc/PID/stat`.
 * Returns null on non-Linux (no `/proc`) or if the file cannot be read —
 * e.g. the process exited between resolving its PID and sampling it.
 */
export function cpuSnapshot(pid: number): ProcCpuSnapshot | null {
  const parsed = parseStatCpu(`/proc/${pid}/stat`);
  if (!parsed) return null;
  return { utime: parsed.utime, stime: parsed.stime, clockMs: Date.now() };
}

/**
 * Compute CPU% of one core between two snapshots.
 * E.g. 11.2 means "11.2% of one core" over the sampled window — can exceed
 * 100 for a multi-threaded process using more than one core's worth of time.
 */
export function cpuPercent(before: ProcCpuSnapshot, after: ProcCpuSnapshot): number {
  const dTicks = (after.utime - before.utime) + (after.stime - before.stime);
  const dMs = after.clockMs - before.clockMs;
  if (dMs <= 0) return 0;
  const cpuMs = (dTicks / CLK_TCK) * 1000;
  return Math.max(0, (cpuMs / dMs) * 100);
}

/** Snapshot every thread's CPU ticks under `/proc/PID/task/`. */
export function threadCpuSnapshot(pid: number): ThreadCpuSnapshot[] {
  const taskDir = `/proc/${pid}/task`;
  if (!existsSync(taskDir)) return [];
  let tids: string[];
  try {
    tids = readdirSync(taskDir);
  } catch {
    return [];
  }
  const result: ThreadCpuSnapshot[] = [];
  for (const tidStr of tids) {
    const tid = parseInt(tidStr, 10);
    if (!Number.isFinite(tid)) continue;
    const parsed = parseStatCpu(`${taskDir}/${tidStr}/stat`);
    if (!parsed) continue;
    result.push({ tid, name: parsed.name, utime: parsed.utime, stime: parsed.stime });
  }
  return result;
}

/** Fields from `/proc/PID/status` (sizes in kB). */
export interface ProcStatus {
  vmRssKb: number | null;
  vmHwmKb: number | null;
  vmSwapKb: number | null;
  rssAnonKb: number | null;
  rssFileKb: number | null;
  threads: number | null;
}

/** Read RSS, peak RSS, swap and thread count from `/proc/PID/status`. Null when the process is gone. */
export function procStatus(pid: number): ProcStatus | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    return null;
  }
  const field = (name: string): number | null => {
    const m = raw.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"));
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    vmRssKb: field("VmRSS"),
    vmHwmKb: field("VmHWM"),
    vmSwapKb: field("VmSwap"),
    rssAnonKb: field("RssAnon"),
    rssFileKb: field("RssFile"),
    threads: field("Threads"),
  };
}

/** `/proc/PID/smaps_rollup` totals in kB (Rss, Pss, Anonymous, Swap, ...). Empty when unreadable. */
export function smapsRollup(pid: number): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const raw = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Za-z_]+):\s+(\d+) kB/);
      if (m) out[m[1]] = parseInt(m[2], 10);
    }
  } catch {}
  return out;
}

/**
 * Every descendant PID of `pid` (children, grandchildren, ...) read from
 * `/proc/PID/task/TID/children`. Needs CONFIG_PROC_CHILDREN (on in Ubuntu kernels).
 */
export function descendantPids(pid: number): number[] {
  const seen = new Set<number>();
  const queue = [pid];
  while (queue.length > 0) {
    const p = queue.shift()!;
    let tids: string[] = [];
    try {
      tids = readdirSync(`/proc/${p}/task`);
    } catch {
      continue;
    }
    for (const tid of tids) {
      let children = "";
      try {
        children = readFileSync(`/proc/${p}/task/${tid}/children`, "utf8").trim();
      } catch {
        continue;
      }
      for (const c of children.split(/\s+/).filter(Boolean)) {
        const n = parseInt(c, 10);
        if (Number.isFinite(n) && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
  }
  return [...seen];
}

/** The command name (`/proc/PID/comm`) of a process, or null when it is gone. */
export function procComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Group a thread name into a pool: strip trailing digits, `#n` and `-n`
 * suffixes so e.g. `tokio-runtime-w` / `worker-12` / `V8 DefaultWorke`
 * collapse to one row per pool. Per-language threads (`lang-<hash prefix>`)
 * collapse to `lang-*`. The kernel truncates comm to 15 bytes.
 */
export function threadPool(name: string): string {
  if (/^lang-/.test(name)) return "lang-*";
  return name.replace(/[\s#:_-]*\d+$/, "").trim() || name;
}

export interface ThreadGroup {
  /** Pool name (see `threadPool`). */
  pool: string;
  /** Distinct raw thread names in this pool. */
  names: string[];
  count: number;
}

/** Count threads of `pid` by pool, largest first. */
export function threadGroups(pid: number): ThreadGroup[] {
  const groups = new Map<string, { names: Set<string>; count: number }>();
  for (const t of threadCpuSnapshot(pid)) {
    const pool = threadPool(t.name);
    const g = groups.get(pool) ?? { names: new Set<string>(), count: 0 };
    g.names.add(t.name);
    g.count++;
    groups.set(pool, g);
  }
  return [...groups.entries()]
    .map(([pool, g]) => ({ pool, names: [...g.names].sort(), count: g.count }))
    .sort((a, b) => b.count - a.count || a.pool.localeCompare(b.pool));
}

/** Total CPU ticks (utime+stime) of a set of PIDs; PIDs that are gone add nothing. */
export function totalCpuTicks(pids: number[]): number {
  let ticks = 0;
  for (const p of pids) {
    const s = cpuSnapshot(p);
    if (s) ticks += s.utime + s.stime;
  }
  return ticks;
}

/** Convert a tick delta over a wall-clock window to percent of one core. */
export function ticksToPercent(dTicks: number, dMs: number): number {
  if (dMs <= 0) return 0;
  return Math.max(0, ((dTicks / CLK_TCK) * 1000 / dMs) * 100);
}

/** Host-wide CPU counters from the first line of `/proc/stat` (all cores, in ticks). */
export interface HostCpuSnapshot {
  busy: number;
  total: number;
}

export function hostCpuSnapshot(): HostCpuSnapshot | null {
  try {
    const line = readFileSync("/proc/stat", "utf8").split("\n")[0];
    const v = line.trim().split(/\s+/).slice(1).map((x) => parseInt(x, 10));
    // user nice system idle iowait irq softirq steal guest guest_nice
    const idle = (v[3] ?? 0) + (v[4] ?? 0);
    const total = v.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    return { busy: total - idle, total };
  } catch {
    return null;
  }
}

/** Host busy fraction (0..100, all cores) between two snapshots. */
export function hostBusyPercent(a: HostCpuSnapshot, b: HostCpuSnapshot): number {
  const dt = b.total - a.total;
  return dt > 0 ? ((b.busy - a.busy) / dt) * 100 : 0;
}

/** The 1, 5 and 15 minute load averages from `/proc/loadavg`. */
export function loadAverage(): [number, number, number] | null {
  try {
    const v = readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/).slice(0, 3).map(Number);
    return [v[0], v[1], v[2]];
  } catch {
    return null;
  }
}

/** Apparent size in bytes of a file or directory tree (sum of file sizes, no symlinks followed). */
export function dirSizeBytes(path: string): number {
  let total = 0;
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  for (const e of entries) total += dirSizeBytes(`${path}/${e}`);
  return total;
}

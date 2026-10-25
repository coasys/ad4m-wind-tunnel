/**
 * W1 helper: executor RSS and CPU from /proc (Linux). Returns null elsewhere or if the PID is gone.
 */

import { readFileSync } from "fs";

export interface ProcSample {
  atMs: number;
  rssMb: number;
  /** user + system CPU seconds since the process started. */
  cpuSec: number;
  threads: number;
}

const CLK_TCK = 100; // Linux USER_HZ; sysconf(_SC_CLK_TCK) is 100 on every mainstream kernel config.

export function sampleProc(pid: number | undefined, atMs: number): ProcSample | null {
  if (!pid || process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the parenthesised comm; utime/stime are fields 14/15 (1-based).
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    const threads = Number(rest[17]);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
    return { atMs, rssMb: Math.round((rssKb / 1024) * 10) / 10, cpuSec: (utime + stime) / CLK_TCK, threads };
  } catch {
    return null;
  }
}

/** CPU seconds and RSS change between two samples. */
export function procDelta(a: ProcSample | null, b: ProcSample | null) {
  if (!a || !b) return null;
  const wallSec = Math.max(0.001, (b.atMs - a.atMs) / 1000);
  const cpuSec = b.cpuSec - a.cpuSec;
  return {
    cpuSec: Math.round(cpuSec * 100) / 100,
    /** Average cores busy over the window (1.0 = one core fully used). */
    cpuCores: Math.round((cpuSec / wallSec) * 100) / 100,
    rssStartMb: a.rssMb,
    rssEndMb: b.rssMb,
    rssDeltaMb: Math.round((b.rssMb - a.rssMb) * 10) / 10,
  };
}

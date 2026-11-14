/**
 * CPU-quota fault injection: run the executor in its own systemd user scope
 * and change the scope's CFS quota while it runs.
 *
 * `systemd-run --user --scope` execs the command in place, so the spawned pid
 * is the executor's. The quota is set with
 * `systemctl --user set-property --runtime <unit> CPUQuota=<n>%` (the cgroup
 * file itself is not writable by the user) and read back from `cpu.max`.
 * systemd cannot set the quota back to "none" at run time, so "no fault" is a
 * quota of every core on the machine, which never binds.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { cpus } from "os";

export function scopeUnitName(tag: string): string {
  return `hex-wt-f1exec-${tag.replace(/[^A-Za-z0-9_-]/g, "-")}-${process.pid}`;
}

/** The launcher prefix for `ExecutorConfig.launcher`. */
export function scopeLauncher(unit: string, memoryMax?: string): string[] {
  return [
    "systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`,
    ...(memoryMax ? ["-p", `MemoryMax=${memoryMax}`, "-p", "MemorySwapMax=0"] : []),
    "--",
  ];
}

/** Whether `systemd-run --user` and a delegated cpu controller are available. */
export function scopeSupported(): { ok: boolean; detail: string } {
  try {
    execFileSync("systemctl", ["--user", "is-system-running"], { stdio: "pipe" });
  } catch (e: any) {
    // "degraded" exits non-zero but works; only a missing manager is fatal.
    const out = String(e?.stdout ?? "");
    if (!/running|degraded/.test(out)) return { ok: false, detail: `no systemd user manager (${out.trim() || e.message})` };
  }
  const ctl = `/sys/fs/cgroup/user.slice/user-${process.getuid?.() ?? 0}.slice/user@${process.getuid?.() ?? 0}.service/cgroup.subtree_control`;
  if (!existsSync(ctl)) return { ok: false, detail: `${ctl} missing (cgroup v2 user delegation)` };
  const ctrls = readFileSync(ctl, "utf8");
  if (!/\bcpu\b/.test(ctrls)) return { ok: false, detail: `cpu controller not delegated to the user manager (${ctrls.trim()})` };
  return { ok: true, detail: "systemd user scope with cpu controller" };
}

export function cgroupPathOf(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::"));
    return line ? `/sys/fs/cgroup${line.slice(3).trim()}` : null;
  } catch {
    return null;
  }
}

/** `cpu.max` as "<quota|max> <period>". */
export function readCpuMax(cgroup: string): string | null {
  try {
    return readFileSync(`${cgroup}/cpu.max`, "utf8").trim();
  } catch {
    return null;
  }
}

export interface CpuStat {
  usageUsec: number;
  nrPeriods: number;
  nrThrottled: number;
  throttledUsec: number;
}

export function parseCpuStat(text: string): CpuStat {
  const get = (k: string) => {
    const m = new RegExp(`^${k} (\\d+)$`, "m").exec(text);
    return m ? parseInt(m[1], 10) : 0;
  };
  return { usageUsec: get("usage_usec"), nrPeriods: get("nr_periods"), nrThrottled: get("nr_throttled"), throttledUsec: get("throttled_usec") };
}

export function readCpuStat(cgroup: string): CpuStat | null {
  try {
    return parseCpuStat(readFileSync(`${cgroup}/cpu.stat`, "utf8"));
  } catch {
    return null;
  }
}

/** Quota percent that never binds on this machine. */
export function unboundedQuotaPercent(): number {
  return Math.max(1, cpus().length) * 100;
}

/** Set the scope's quota (percent of one core; null = unbounded) and return the resulting `cpu.max`. */
export function setCpuQuota(unit: string, cgroup: string, percent: number | null): string | null {
  const value = percent == null ? unboundedQuotaPercent() : percent;
  execFileSync("systemctl", ["--user", "set-property", "--runtime", `${unit}.scope`, `CPUQuota=${value}%`], { stdio: "pipe" });
  return readCpuMax(cgroup);
}

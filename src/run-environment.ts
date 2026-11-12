/**
 * What a result was measured on: the executor build, the machine and its load.
 * Every result file carries one of these (`ScenarioResult.environment`) so a
 * number can be compared with a later run on another ad4m branch.
 *
 * No host name, user name or path outside the executor binary is recorded.
 */

import { execFileSync } from "child_process";
import { cpus, totalmem, release, platform, arch } from "os";
import { readFileSync } from "fs";
import { InstrumentedClient } from "./client.js";
import { loadAverage } from "./proc-metrics.js";

export interface RunEnvironment {
  /** `runtime.info` → `ad4mExecutorCommit` (null when the build could not tell). */
  ad4mCommit: string | null;
  ad4mExecutorVersion: string | null;
  /** `ad4m-executor --version` output. */
  executorVersionString: string | null;
  executorBinary: string | null;
  runHolochain: boolean | null;
  machine: {
    cpuCount: number;
    cpuModel: string | null;
    totalRamGb: number;
    os: string;
    kernel: string;
  };
  /** Load averages (1, 5, 15 min) when the scenario started and ended. */
  loadAvgStart: [number, number, number] | null;
  loadAvgEnd: [number, number, number] | null;
  /** Swap in use on the host (kB) at start and end, from /proc/meminfo. */
  hostSwapUsedKbStart: number | null;
  hostSwapUsedKbEnd: number | null;
  /** `--repeat` index of this run (1-based). */
  runIndex: number;
  startedAt: string;
}

export function hostSwapUsedKb(): number | null {
  try {
    const raw = readFileSync("/proc/meminfo", "utf8");
    const total = raw.match(/^SwapTotal:\s+(\d+)/m);
    const free = raw.match(/^SwapFree:\s+(\d+)/m);
    if (!total || !free) return null;
    return parseInt(total[1], 10) - parseInt(free[1], 10);
  } catch {
    return null;
  }
}

function executorVersion(binary: string | undefined): string | null {
  if (!binary) return null;
  try {
    return execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

/** Executor commit and version from `runtime.info` (nulls when the call fails). */
export async function executorIdentity(client: InstrumentedClient): Promise<{ ad4mCommit: string | null; ad4mExecutorVersion: string | null }> {
  try {
    const info: any = await client.call("runtime.info", {});
    return { ad4mCommit: info?.ad4mExecutorCommit ?? null, ad4mExecutorVersion: info?.ad4mExecutorVersion ?? null };
  } catch {
    return { ad4mCommit: null, ad4mExecutorVersion: null };
  }
}

/** Capture the environment at scenario start. `client` must be connected. */
export async function captureRunEnvironment(opts: {
  client?: InstrumentedClient;
  executorPath?: string;
  runHolochain?: boolean;
  runIndex: number;
}): Promise<RunEnvironment> {
  const { ad4mCommit, ad4mExecutorVersion } = opts.client
    ? await executorIdentity(opts.client)
    : { ad4mCommit: null, ad4mExecutorVersion: null };
  const c = cpus();
  return {
    ad4mCommit,
    ad4mExecutorVersion,
    executorVersionString: executorVersion(opts.executorPath),
    executorBinary: opts.executorPath ?? null,
    runHolochain: opts.runHolochain ?? null,
    machine: {
      cpuCount: c.length,
      cpuModel: c[0]?.model ?? null,
      totalRamGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      os: `${platform()}-${arch()}`,
      kernel: release(),
    },
    loadAvgStart: loadAverage(),
    loadAvgEnd: null,
    hostSwapUsedKbStart: hostSwapUsedKb(),
    hostSwapUsedKbEnd: null,
    runIndex: opts.runIndex,
    startedAt: new Date().toISOString(),
  };
}

/** Fill in the end-of-scenario fields. */
export function finishRunEnvironment(env: RunEnvironment): RunEnvironment {
  return { ...env, loadAvgEnd: loadAverage(), hostSwapUsedKbEnd: hostSwapUsedKb() };
}

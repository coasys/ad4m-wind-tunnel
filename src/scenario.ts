/**
 * Scenario Interface and Registry
 */

import { InstrumentedClient } from "./client.js";
import type { RunEnvironment } from "./run-environment.js";

export interface ScenarioResult {
  scenario: string;
  branch: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  /** Hard pass/fail verdict — the runner gates on this field. */
  passed: boolean;
  metrics: Record<string, any>;
  samples: Array<{ name: string; durationMs: number; timestamp: number; error?: string }>;
  summary: string;
  /** True when a dependency was unreachable and nothing was measured. */
  skipped?: boolean;
  /** Executor build, machine, Holochain flag and load (set by the runner). */
  environment?: RunEnvironment;
  /** Human-readable report written next to the JSON as `<scenario>.md`. */
  markdown?: string;
}

export interface ScenarioContext {
  client: InstrumentedClient;
  branch: string;
  port: number;
  /** Admin token for executor authentication */
  adminToken: string;
  /** Path to the AD4M repo (for building/cloning) */
  adamRepoPath: string;
  /** Base directory for temporary files */
  tmpDirBase: string;
  /**
   * Absolute path to the executor binary the runner started for this branch.
   * Scenarios that spin up a second executor (e.g. c1 convergence) use this so
   * they work under `--executor-path`, where the binary is not in the build dir.
   */
  executorPath?: string;
  /** Whether the runner started the executor with Holochain (`--run-holochain`). */
  runHolochain?: boolean;
  /** Data directory for this scenario run; the runner deletes it afterwards. */
  dataPath?: string;
  /** Extra `run` flags for this scenario (scenarios that start their own executor reuse them). */
  extraArgs?: string[];
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  /**
   * When true, the runner does NOT boot a native executor or connect a client
   * for this scenario — the scenario stands up and tears down its own
   * environment (e.g. a Docker pod). `ctx.client` is undefined in that case.
   * Used by the agent-harness (A-series) pod scenarios.
   */
  managesOwnEnvironment?: boolean;
  run(ctx: ScenarioContext): Promise<ScenarioResult>;
}

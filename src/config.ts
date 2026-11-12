/**
 * Centralized configuration for AD4M Wind Tunnel.
 *
 * All machine-specific values are configurable via environment variables
 * and/or CLI arguments. CLI args take precedence over env vars.
 */

import { tmpdir } from "os";
import { join } from "path";

export interface WindTunnelConfig {
  /** Path to the AD4M repo (for building executor from source) */
  adamRepoPath: string;
  /** Admin token for executor authentication */
  adminToken: string;
  /** Base directory for temporary files (data dirs, build dirs) */
  tmpDirBase: string;
  /** Base port for executor instances */
  basePort: number;
  /** Directory for storing results */
  resultsDir: string;
  /**
   * Start executors with the embedded Holochain conductor (`--run-holochain`).
   * Hosted deployments run with it off (`AD4M_RUN_HOLOCHAIN=false`).
   */
  runHolochain: boolean;
  /** Run each selected scenario this many times, each on a fresh executor. */
  repeat: number;
  /** Base URL of the link-server the server link language syncs through. */
  linkServerUrl: string;
}

export function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(s)) return true;
  if (["0", "false", "off", "no"].includes(s)) return false;
  throw new Error(`Not a boolean: "${v}" (use true/false)`);
}

/**
 * Parse CLI arguments for config overrides.
 * Returns only the config-related args; other args (--scenario, --branch, etc.)
 * are handled by the main runner's parseArgs().
 */
export function parseConfigArgs(args: string[] = process.argv.slice(2)): Partial<WindTunnelConfig> {
  const result: Partial<WindTunnelConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--ad4m-repo":
        result.adamRepoPath = args[++i];
        break;
      case "--admin-token":
        result.adminToken = args[++i];
        break;
      case "--tmp-dir":
        result.tmpDirBase = args[++i];
        break;
      case "--base-port":
        result.basePort = parseInt(args[++i], 10);
        break;
      case "--results-dir":
        result.resultsDir = args[++i];
        break;
      case "--run-holochain":
        result.runHolochain = parseBool(args[++i]);
        break;
      case "--repeat":
        result.repeat = parseInt(args[++i], 10);
        break;
      case "--link-server-url":
        result.linkServerUrl = args[++i];
        break;
    }
  }

  return result;
}

/**
 * Build the resolved config by merging defaults < env vars < CLI args.
 */
export function resolveConfig(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): WindTunnelConfig {
  const cliArgs = parseConfigArgs(args);
  const systemTmp = tmpdir();

  return {
    adamRepoPath:
      cliArgs.adamRepoPath
      ?? env.AD4M_REPO
      ?? "",
    adminToken:
      cliArgs.adminToken
      ?? env.AD4M_ADMIN_TOKEN
      ?? "test123",
    tmpDirBase:
      cliArgs.tmpDirBase
      ?? env.AD4M_WT_TMPDIR
      ?? systemTmp,
    basePort:
      cliArgs.basePort
      ?? (env.AD4M_WT_BASE_PORT ? parseInt(env.AD4M_WT_BASE_PORT, 10) : 12100),
    resultsDir:
      cliArgs.resultsDir
      ?? env.AD4M_WT_RESULTS_DIR
      ?? join(process.cwd(), "results"),
    runHolochain:
      cliArgs.runHolochain
      ?? parseBool(env.AD4M_WT_RUN_HOLOCHAIN)
      ?? true,
    // `|| 1` turns a non-numeric value (NaN) into one run.
    repeat: Math.max(
      1,
      (cliArgs.repeat
        ?? (env.AD4M_WT_REPEAT ? parseInt(env.AD4M_WT_REPEAT, 10) : 1)) || 1,
    ),
    linkServerUrl:
      cliArgs.linkServerUrl
      ?? env.LINK_SERVER_URL
      ?? "http://127.0.0.1:3456",
  };
}

/** Singleton resolved config */
export const config = resolveConfig();

/**
 * Validate that required config values are present.
 * Call this before operations that need the AD4M repo path.
 */
export function validateAdamRepo(): void {
  if (!config.adamRepoPath) {
    console.error(
      "[config] AD4M repo path is required.\n" +
      "  Set via: --ad4m-repo <path>, or AD4M_REPO env var.\n" +
      "  Example: AD4M_REPO=/path/to/ad4m npx tsx src/main.ts"
    );
    process.exit(1);
  }
}

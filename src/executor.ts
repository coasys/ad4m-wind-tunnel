/**
 * Executor Lifecycle Manager
 * Handles building, starting, stopping, and health-checking AD4M executor instances.
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { Transport } from "./client.js";

export interface ExecutorConfig {
  branch: string;
  port: number;
  dataPath: string;
  adminToken: string;
  adamRepoPath: string;
  buildDir: string;
  transport: Transport;
}

export interface ExecutorInstance {
  config: ExecutorConfig;
  process: ChildProcess | null;
  binaryPath: string;
  buildDurationMs: number;
  startDurationMs: number;
}

export async function buildExecutor(config: ExecutorConfig): Promise<string> {
  const { branch, buildDir, adamRepoPath } = config;

  console.log(`[executor] Building branch: ${branch} in ${buildDir}`);

  if (existsSync(buildDir)) {
    rmSync(buildDir, { recursive: true, force: true });
  }

  execSync(
    `git clone --depth 1 --branch ${branch} --single-branch "${adamRepoPath}" "${buildDir}"`,
    { stdio: "pipe", timeout: 60000 }
  );

  // Ensure dapp/dist placeholder exists
  const dappDir = join(buildDir, "dapp", "dist");
  mkdirSync(dappDir, { recursive: true });
  if (!existsSync(join(dappDir, "index.html"))) {
    writeFileSync(join(dappDir, "index.html"), "<!DOCTYPE html><html><body></body></html>");
  }

  // Copy CUSTOM_DENO_SNAPSHOT.bin
  const snapshotSrc = join(adamRepoPath, "CUSTOM_DENO_SNAPSHOT.bin");
  if (existsSync(snapshotSrc)) {
    console.log(`[executor] Copying CUSTOM_DENO_SNAPSHOT.bin...`);
    // Put in both root and rust-executor/ to cover both include_bytes paths
    execSync(`cp "${snapshotSrc}" "${join(buildDir, "CUSTOM_DENO_SNAPSHOT.bin")}"`, { stdio: "pipe" });
    execSync(`cp "${snapshotSrc}" "${join(buildDir, "rust-executor", "CUSTOM_DENO_SNAPSHOT.bin")}"`, { stdio: "pipe" });
  }

  // Copy schema.gql if needed
  const schemaSrc = join(adamRepoPath, "core", "lib", "src", "schema.gql");
  if (existsSync(schemaSrc)) {
    const schemaTarget = join(buildDir, "core", "lib", "src");
    mkdirSync(schemaTarget, { recursive: true });
    execSync(`cp "${schemaSrc}" "${join(schemaTarget, "schema.gql")}"`, { stdio: "pipe" });
  }

  // Build the executor
  console.log(`[executor] Building ad4m-executor for ${branch}...`);
  execSync("cargo build --release --bin ad4m-executor 2>&1", {
    cwd: buildDir,
    stdio: "pipe",
    timeout: 1800000, // 30 min
  });

  const binaryPath = join(buildDir, "target", "release", "ad4m-executor");
  if (!existsSync(binaryPath)) {
    throw new Error(`Binary not found at ${binaryPath}`);
  }

  console.log(`[executor] Build complete: ${binaryPath}`);
  return binaryPath;
}

export async function initExecutor(binaryPath: string, dataPath: string): Promise<void> {
  // Clean data directory
  if (existsSync(dataPath)) {
    rmSync(dataPath, { recursive: true, force: true });
  }
  mkdirSync(dataPath, { recursive: true });

  // Run init
  console.log(`[executor] Initializing data at ${dataPath}...`);
  execSync(`"${binaryPath}" init --data-path "${dataPath}" 2>&1`, {
    stdio: "pipe",
    timeout: 30000,
  });
}

export async function startExecutor(
  binaryPath: string,
  config: ExecutorConfig
): Promise<ChildProcess> {
  // Initialize if needed
  await initExecutor(binaryPath, config.dataPath);

  console.log(`[executor] Starting on port ${config.port}, data: ${config.dataPath}`);

  const proc = spawn(binaryPath, [
    "run",
    "--app-data-path", config.dataPath,
    "--gql-port", String(config.port),
    "--admin-credential", config.adminToken,
    "--run-dapp-server", "false",
    "--hc-use-bootstrap", "false",
    "--hc-use-proxy", "false",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "info" },
  });

  proc.stdout?.on("data", (d) => {
    const line = d.toString().trim();
    if (line && process.env.VERBOSE) console.log(`[exec:${config.port}:out] ${line}`);
  });
  proc.stderr?.on("data", (d) => {
    const line = d.toString().trim();
    if (line && process.env.VERBOSE) console.log(`[exec:${config.port}:err] ${line}`);
  });

  return proc;
}

export async function waitForHealth(
  port: number,
  transport: Transport,
  timeoutMs: number = 60000
): Promise<number> {
  const start = performance.now();
  const deadline = start + timeoutMs;

  // GraphQL branches: GET / returns 200
  // REST branches: GET /health returns JSON
  const healthUrl = transport === "graphql"
    ? `http://127.0.0.1:${port}/`
    : `http://127.0.0.1:${port}/health`;

  while (performance.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        return performance.now() - start;
      }
    } catch {}
    await sleep(500);
  }

  throw new Error(`Executor on port ${port} did not become healthy within ${timeoutMs}ms`);
}

export function stopExecutor(proc: ChildProcess): void {
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

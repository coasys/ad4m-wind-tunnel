/**
 * Executor Lifecycle Manager
 * Handles building, starting, stopping, and health-checking AD4M executor instances.
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { mkdirSync, existsSync, writeFileSync, rmSync, readFileSync, copyFileSync, statSync, createWriteStream } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";

/**
 * The snapshot is determined by whichever `deno_runtime` git revision is
 * resolved by `Cargo.lock`. Cache it keyed by that revision so subsequent
 * branches with the same Deno pin reuse the same bytes, and so multi-branch
 * comparison runs only pay the snapshot cost once per Deno version.
 */
function snapshotCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dir = join(base, "ad4m-wind-tunnel", "deno-snapshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Parse the resolved git revision for `deno_runtime` from a Cargo.lock file. */
function denoRuntimeRevision(buildDir: string): string | null {
  const lockPath = join(buildDir, "Cargo.lock");
  if (!existsSync(lockPath)) return null;
  const lock = readFileSync(lockPath, "utf8");
  // Each [[package]] block is small; find the one named deno_runtime and
  // pull the trailing `#<sha>` from its `source = "git+...#<sha>"` line.
  const match = lock.match(
    /\[\[package\]\][\s\S]*?name\s*=\s*"deno_runtime"[\s\S]*?source\s*=\s*"git\+[^"#]+#([0-9a-f]+)"/
  );
  return match ? match[1] : null;
}

function snapshotIsValid(p: string): boolean {
  // Empty file = stub seed; treat as invalid so we always regen on miss.
  return existsSync(p) && statSync(p).size > 0;
}

export interface ExecutorConfig {
  branch: string;
  port: number;
  dataPath: string;
  adminToken: string;
  adamRepoPath: string;
  buildDir: string;
  /** Extra CLI args appended to the `run` invocation (e.g. ["--language-language-only","true"]). */
  extraArgs?: string[];
  /**
   * `--run-holochain` value. Undefined leaves the executor default (on).
   * Always passed explicitly by the runner so an inherited AD4M_RUN_HOLOCHAIN
   * cannot change a run silently.
   */
  runHolochain?: boolean;
  /** Keep an existing data directory (restart) instead of wiping and re-running `init`. */
  skipInit?: boolean;
  /**
   * Command that wraps the `run` invocation, e.g. `systemd-run --user --scope …`
   * so the executor gets its own cgroup (f1 sets a CPU quota on it). The
   * wrapper must exec the executor in place, so the spawned pid is the
   * executor's. `init` is never wrapped.
   */
  launcher?: string[];
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

  // `CUSTOM_DENO_SNAPSHOT.bin` is consumed by `include_bytes!` in
  // `js_core/options.rs`, so the file must exist at compile time. Its content
  // also has to match the linked `deno_runtime`'s V8 — a mismatch causes the
  // executor to panic at language-runtime init with
  // `Check failed: magic_number_ == SerializedData::kMagicNumber`.
  //
  // The snapshot is fully determined by whichever `deno_runtime` git
  // revision the branch's `Cargo.lock` resolves to, so we cache it keyed by
  // that revision under `$XDG_CACHE_HOME/ad4m-wind-tunnel/deno-snapshots/`.
  // Multi-branch runs whose Cargo.lock all point at the same Deno commit
  // pay the snapshot cost once and copy thereafter.
  const snapshotRootPath = join(buildDir, "CUSTOM_DENO_SNAPSHOT.bin");
  const snapshotRustExecutorPath = join(buildDir, "rust-executor", "CUSTOM_DENO_SNAPSHOT.bin");

  const denoRev = denoRuntimeRevision(buildDir);
  const cachePath = denoRev
    ? join(snapshotCacheDir(), `${denoRev}.bin`)
    : null;

  // Copy schema.gql if needed (must precede `cargo run`, which compiles core/).
  const schemaSrc = join(adamRepoPath, "core", "lib", "src", "schema.gql");
  if (existsSync(schemaSrc)) {
    const schemaTarget = join(buildDir, "core", "lib", "src");
    mkdirSync(schemaTarget, { recursive: true });
    execSync(`cp "${schemaSrc}" "${join(schemaTarget, "schema.gql")}"`, { stdio: "pipe" });
  }

  if (cachePath && snapshotIsValid(cachePath)) {
    console.log(`[executor] Using cached snapshot for deno_runtime ${denoRev!.slice(0, 12)}`);
    copyFileSync(cachePath, snapshotRootPath);
    copyFileSync(cachePath, snapshotRustExecutorPath);
  } else {
    // Seed a stub so `include_bytes!` compiles the snapshot generator, then
    // run the generator to write real bytes against the build's own deno deps.
    writeFileSync(snapshotRootPath, "");
    writeFileSync(snapshotRustExecutorPath, "");
    console.log(
      cachePath
        ? `[executor] Generating snapshot for deno_runtime ${denoRev!.slice(0, 12)}...`
        : `[executor] Generating snapshot (Cargo.lock deno_runtime revision unresolved)...`
    );
    execSync("cargo run --release --bin generate_snapshot 2>&1", {
      cwd: join(buildDir, "rust-executor"),
      stdio: "pipe",
      timeout: 1800000,
    });
    copyFileSync(snapshotRustExecutorPath, snapshotRootPath);
    if (cachePath) {
      copyFileSync(snapshotRustExecutorPath, cachePath);
      console.log(`[executor] Cached snapshot at ${cachePath}`);
    }
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
  // Initialize unless this is a restart on an existing data directory
  if (!config.skipInit) await initExecutor(binaryPath, config.dataPath);

  console.log(`[executor] Starting on port ${config.port}, data: ${config.dataPath}`);

  const launcher = config.launcher ?? [];
  const proc = spawn(launcher.length > 0 ? launcher[0] : binaryPath, [
    ...(launcher.length > 0 ? [...launcher.slice(1), binaryPath] : []),
    "run",
    "--app-data-path", config.dataPath,
    "--port", String(config.port),
    "--admin-credential", config.adminToken,
    "--run-dapp-server", "false",
    "--hc-use-bootstrap", "false",
    "--hc-use-proxy", "false",
    "--enable-multi-user", "true",
    // The executor exits when the wind tunnel does, so a crashed run leaves no executor behind.
    "--exit-with-parent", "true",
    ...(config.runHolochain === undefined ? [] : ["--run-holochain", String(config.runHolochain)]),
    ...(config.extraArgs ?? []),
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "info" },
  });

  // AD4M_WT_EXECUTOR_LOG_DIR keeps each executor's output (e.g. the `timing:` lines).
  const logDir = process.env.AD4M_WT_EXECUTOR_LOG_DIR;
  let logStream: ReturnType<typeof createWriteStream> | null = null;
  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    logStream = createWriteStream(join(logDir, `executor-${config.port}-${Date.now()}.log`), { flags: "a" });
    proc.once("exit", () => logStream?.end());
  }
  proc.stdout?.on("data", (d) => {
    logStream?.write(d);
    const line = d.toString().trim();
    if (line && process.env.VERBOSE) console.log(`[exec:${config.port}:out] ${line}`);
  });
  proc.stderr?.on("data", (d) => {
    logStream?.write(d);
    const line = d.toString().trim();
    if (line && process.env.VERBOSE) console.log(`[exec:${config.port}:err] ${line}`);
  });

  return proc;
}

/**
 * Poll `/health` (and one RPC answer) until the executor is up. Returns the
 * wait in ms; its resolution is `pollMs`, so boot-time measurements pass a
 * small value.
 */
export async function waitForHealth(
  port: number,
  timeoutMs: number = 60000,
  adminToken: string = "test123",
  pollMs: number = 500
): Promise<number> {
  const start = performance.now();
  const deadline = start + timeoutMs;

  const healthUrl = `http://127.0.0.1:${port}/health`;

  while (performance.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        // Also verify WS endpoint is accepting connections
        const wsReady = await checkWsReady(port, adminToken, 5000).catch(() => false);
        if (!wsReady) {
          await sleep(pollMs);
          continue;
        }
        return performance.now() - start;
      }
    } catch {}
    await sleep(pollMs);
  }

  throw new Error(`Executor on port ${port} did not become healthy within ${timeoutMs}ms`);
}

async function checkWsReady(port: number, token: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${token}`);
    const timer = setTimeout(() => { ws.close(); resolve(false); }, timeoutMs);
    ws.on("open", () => {
      // Send a lightweight RPC call to verify the executor is actually ready
      const id = "health-check-1";
      ws.send(JSON.stringify({ id, type: "agent.status", params: {} }));
    });
    ws.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === "health-check-1") {
          clearTimeout(timer);
          ws.close();
          resolve(true);
        }
      } catch {}
    });
    ws.on("error", () => { clearTimeout(timer); ws.close(); resolve(false); });
  });
}

export function stopExecutor(proc: ChildProcess): void {
  void stopExecutorAndWait(proc);
}

/**
 * SIGTERM, then SIGKILL after `graceMs` if the process has not exited.
 * `proc.killed` turns true as soon as a signal is sent, so exit is tracked
 * through `exitCode`/`signalCode` and the `exit` event instead.
 */
export async function stopExecutorAndWait(proc: ChildProcess | null, graceMs = 10000): Promise<void> {
  if (!proc) return;
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  if (exited()) return;
  const done = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.kill("SIGTERM");
  const graceful = await Promise.race([done.then(() => true), sleep(graceMs).then(() => false)]);
  if (!graceful && !exited()) {
    proc.kill("SIGKILL");
    await Promise.race([done, sleep(5000)]);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

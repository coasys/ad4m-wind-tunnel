/**
 * Serves WE's web app from its checkout with the Vite dev server — the way WE developers run it,
 * and always the checkout's current source rather than a build that may be stale.
 */

import { spawn } from "child_process";
import { sleep } from "../executor.js";
import type { WeEnv } from "./env.js";

export interface WeServer {
  url: string;
  logTail(): string;
  stop(): Promise<void>;
}

export async function startWeServer(env: WeEnv, port: number, timeoutMs = 120000): Promise<WeServer> {
  const childEnv = { ...process.env };
  // A shell-wide NODE_ENV=production puts Vite's dev server into production mode.
  delete childEnv.NODE_ENV;

  // Not detached, so a Ctrl-C of the runner reaches it too.
  const proc = spawn(process.execPath, [env.viteBin, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: env.weWebDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const log: string[] = [];
  const keep = (d: Buffer) => {
    log.push(...d.toString().split("\n").filter((l) => l.trim()));
    if (log.length > 300) log.splice(0, log.length - 300);
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);

  let exited = false;
  proc.on("exit", () => {
    exited = true;
  });

  const url = `http://127.0.0.1:${port}`;
  const server: WeServer = {
    url,
    logTail: () => log.slice(-40).join("\n"),
    async stop() {
      if (exited) return;
      proc.kill("SIGTERM");
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
      if (!exited) proc.kill("SIGKILL");
    },
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`WE dev server exited during startup:\n${server.logTail()}`);
    try {
      if ((await fetch(url)).ok) return server;
    } catch {}
    await sleep(500);
  }
  await server.stop();
  throw new Error(`WE dev server did not answer on ${url} within ${timeoutMs}ms:\n${server.logTail()}`);
}

/**
 * Multi-node cascade harness for T3 / T4 / M3 / S2 / S3.
 *
 * Spawns N ad4m executors on consecutive ports, each with its own
 * data dir, and seeds each node's CascadeManager with the others as
 * static peers via the admin `sfu.enableCascade` RPC.
 *
 * This is wind-tunnel-only orchestration — production cascades flow
 * through the neighbourhood gossip layer.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn, execSync, ChildProcess } from "node:child_process";
import { join } from "node:path";

import { InstrumentedClient } from "./client.js";

/**
 * Path to the `ad4m-executor` release binary.  Override via the
 * `AD4M_EXECUTOR_BIN` env var when running locally; otherwise we look
 * for the standard relative build path that `cargo build --release`
 * produces under the ad4m checkout.
 */
const BIN =
  process.env.AD4M_EXECUTOR_BIN ??
  "../ad4m/target/release/ad4m-executor";
const ADMIN_TOKEN = process.env.AD4M_ADMIN_TOKEN ?? "test-admin-token";

export interface CascadeNode {
  id: string;
  port: number;
  dataPath: string;
  process: ChildProcess;
  client: InstrumentedClient;
  /** Synthetic node DID (the wind tunnel's identifier, not the executor agent DID). */
  did: string;
  /** UDP address advertised to peer nodes — wind-tunnel-internal sentinel value. */
  addr: string;
}

export interface CascadeClusterOptions {
  /** Number of nodes to spawn. */
  nodeCount: number;
  /** Each node accepts at most this many participants before redirecting. */
  maxParticipantsPerNode: number;
  /** Starting port — node `i` listens on `basePort + i`. */
  basePort?: number;
}

export interface CascadeCluster {
  nodes: CascadeNode[];
  /**
   * Tell every node OTHER than `landedNode` that `landedNode` now has
   * `count` participants in `roomId`.  Static cascade view stays
   * fresh, so least-loaded picks land on actually-empty nodes
   * instead of bouncing between nodes that all look like 0.
   */
  announceCount(landedNode: CascadeNode, roomId: string, count: number): Promise<void>;
  shutdown(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(port: number, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      /* not ready */
    }
    await sleep(500);
  }
  throw new Error(`Executor on port ${port} did not become healthy in ${timeoutMs}ms`);
}

/**
 * Initialise a fresh data dir for an executor.  Idempotent — wipes any
 * existing dir.
 */
function initDataDir(dataPath: string): void {
  if (existsSync(dataPath)) {
    rmSync(dataPath, { recursive: true, force: true });
  }
  mkdirSync(dataPath, { recursive: true });
  execSync(`${BIN} init --data-path ${dataPath}`, { stdio: "pipe" });
}

export async function startCluster(opts: CascadeClusterOptions): Promise<CascadeCluster> {
  const basePort = opts.basePort ?? 12000;
  const nodes: CascadeNode[] = [];

  for (let i = 0; i < opts.nodeCount; i++) {
    const port = basePort + i;
    const dataPath = `/tmp/ad4m-cascade-node-${i}`;
    initDataDir(dataPath);

    const proc = spawn(
      BIN,
      [
        "run",
        "--app-data-path",
        dataPath,
        "--port",
        String(port),
        "--admin-credential",
        ADMIN_TOKEN,
        "--run-dapp-server",
        "false",
        "--hc-use-bootstrap",
        "false",
        "--hc-use-proxy",
        "false",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, RUST_LOG: "info" },
      },
    );

    await waitForHealth(port);

    const client = new InstrumentedClient({ port, adminToken: ADMIN_TOKEN });
    await client.connect();
    // Each executor's main agent comes from agent.generate; for the
    // cascade the DID/addr are synthetic — they identify the node in
    // the harness but the wind tunnel never actually relays media
    // between nodes (pipe transport is out of scope for this pass).
    const gen = await client.generateAgent("wind-tunnel-cascade").catch(() => ({
      error: "swallowed",
    }));
    void gen;

    nodes.push({
      id: `node-${i}`,
      port,
      dataPath,
      process: proc,
      client,
      did: `did:windtunnel:cascade:node-${i}`,
      addr: `127.0.0.1:${50000 + i}`,
    });
  }

  // Wire every node's known_nodes with the OTHER nodes' (did, addr).
  for (const node of nodes) {
    const peers = nodes
      .filter((p) => p.id !== node.id)
      .map((p) => ({ did: p.did, addr: p.addr }));
    await node.client.call("sfu.enableCascade", {
      localDid: node.did,
      maxParticipantsPerNode: opts.maxParticipantsPerNode,
      peers,
    });
  }

  return {
    nodes,
    async announceCount(landedNode, roomId, count): Promise<void> {
      const others = nodes.filter((n) => n.id !== landedNode.id);
      await Promise.all(
        others.map((n) =>
          n.client
            .call("sfu.cascadeAnnounce", {
              remoteDid: landedNode.did,
              roomId,
              participantCount: count,
            })
            .catch(() => undefined),
        ),
      );
    },
    async shutdown(): Promise<void> {
      for (const n of nodes) {
        try {
          await n.client.disconnect();
        } catch {}
        try {
          n.process.kill("SIGTERM");
        } catch {}
      }
      // Give executors a beat to drop their UDP sockets.
      await sleep(500);
      for (const n of nodes) {
        if (existsSync(n.dataPath)) {
          try {
            rmSync(n.dataPath, { recursive: true, force: true });
          } catch {}
        }
      }
    },
  };
}

/**
 * Multi-node cascade harness for T3 / T4 / M3 / F4 / S2 / S3.
 *
 * Each node is a real ad4m-executor process spawned with cascade
 * gossip enabled via CLI flags (`--sfu-local-did`,
 * `--sfu-cascade-listen`, `--sfu-cascade-peers`) — no admin RPCs
 * required.  The executor's built-in TCP gossip transport exchanges
 * announce / leave / pipe-offer signals between nodes and the
 * CascadeManager picks redirects based on the live cross-node view.
 *
 * Production deployments use the same `CascadeGossip` trait wired to
 * whatever signalling layer the host application owns (Holochain
 * neighbourhood signals for AD4M, libp2p for another runtime, etc.).
 * The wind tunnel TCP transport is one of several backends.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn, execSync, ChildProcess } from "node:child_process";

import { InstrumentedClient } from "./client.js";

const BIN =
  process.env.AD4M_EXECUTOR_BIN ??
  "../ad4m/target/release/ad4m-executor";
const ADMIN_TOKEN = process.env.AD4M_ADMIN_TOKEN ?? "test-admin-token";

export interface CascadeNode {
  id: string;
  /** WS RPC port (`/api/v1/ws`). */
  port: number;
  /** Cascade gossip listener port (TCP). */
  gossipPort: number;
  dataPath: string;
  process: ChildProcess;
  /** Admin client to this executor — used for user provisioning + room mgmt. */
  client: InstrumentedClient;
  /** Cascade-cluster DID for this node. */
  did: string;
}

export interface CascadeClusterOptions {
  nodeCount: number;
  maxParticipantsPerNode: number;
  /** WS RPC port base — node `i` listens on `wsBasePort + i`. */
  wsBasePort?: number;
  /** Cascade gossip port base — node `i` binds `gossipBasePort + i`. */
  gossipBasePort?: number;
}

export interface CascadeCluster {
  nodes: CascadeNode[];
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

function initDataDir(dataPath: string): void {
  if (existsSync(dataPath)) {
    rmSync(dataPath, { recursive: true, force: true });
  }
  mkdirSync(dataPath, { recursive: true });
  execSync(`${BIN} init --data-path ${dataPath}`, { stdio: "pipe" });
}

export async function startCluster(opts: CascadeClusterOptions): Promise<CascadeCluster> {
  const wsBasePort = opts.wsBasePort ?? 12000;
  const gossipBasePort = opts.gossipBasePort ?? 24000;
  const nodes: CascadeNode[] = [];

  // Pre-compute node identities so each one can be passed the full
  // peer list at spawn time.
  const plannedNodes = Array.from({ length: opts.nodeCount }, (_, i) => ({
    id: `node-${i}`,
    port: wsBasePort + i,
    gossipPort: gossipBasePort + i,
    dataPath: `/tmp/ad4m-cascade-node-${i}`,
    did: `did:windtunnel:cascade:node-${i}`,
  }));

  for (let i = 0; i < plannedNodes.length; i++) {
    const planned = plannedNodes[i];
    initDataDir(planned.dataPath);

    // Every other node's `did=host:port` entries — what the gossip
    // CLI flag expects.
    const peerEntries = plannedNodes
      .filter((_, j) => j !== i)
      .map((p) => `${p.did}=127.0.0.1:${p.gossipPort}`)
      .join(",");

    const args: string[] = [
      "run",
      "--app-data-path", planned.dataPath,
      "--port", String(planned.port),
      "--admin-credential", ADMIN_TOKEN,
      "--run-dapp-server", "false",
      "--hc-use-bootstrap", "false",
      "--hc-use-proxy", "false",
      "--enable-multi-user", "true",
      "--sfu-local-did", planned.did,
      "--sfu-max-participants-per-node", String(opts.maxParticipantsPerNode),
      "--sfu-cascade-listen", `127.0.0.1:${planned.gossipPort}`,
    ];
    if (peerEntries) {
      args.push("--sfu-cascade-peers", peerEntries);
    }

    const proc = spawn(BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RUST_LOG: "info" },
    });

    await waitForHealth(planned.port);

    const client = new InstrumentedClient({ port: planned.port, adminToken: ADMIN_TOKEN });
    await client.connect();
    await client.generateAgent("wind-tunnel-cascade").catch(() => undefined);

    nodes.push({
      id: planned.id,
      port: planned.port,
      gossipPort: planned.gossipPort,
      dataPath: planned.dataPath,
      process: proc,
      client,
      did: planned.did,
    });
  }

  return {
    nodes,
    async shutdown(): Promise<void> {
      for (const n of nodes) {
        try {
          await n.client.disconnect();
        } catch {}
        try {
          n.process.kill("SIGTERM");
        } catch {}
      }
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

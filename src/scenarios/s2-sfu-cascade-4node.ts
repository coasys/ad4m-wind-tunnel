/**
 * S2: Cascaded 4-node × 40 peers.
 *
 * Same shape as T4 with 4 nodes and 40 peers (10 per node @
 * max=10).  Stresses the cascade decision under load.
 *
 * Each peer issues `sfu.callJoin` against node A and follows any
 * `redirectTo`; the wind tunnel verifies the room ends up split
 * 10/10/10/10 across the cluster (give or take 1 due to redirect
 * decision timing).
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { WebRtcPeer } from "../peer.js";
import { startCluster, CascadeNode } from "../cascade.js";

const ROOM_NAME = "s2-sfu-cascade-4node";
const NEIGHBOURHOOD = `windtunnel://s2`;
const PEER_COUNT = 40;
const MAX_PER_NODE = 10;

export const s2SfuCascade4Node: Scenario = {
  id: "s2",
  name: "Cascaded 4-node × 40 peers",
  description: "Four SFU nodes, 40 peers; cascade decision under load",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const metrics: Record<string, unknown> = {};

    let cluster: Awaited<ReturnType<typeof startCluster>> | null = null;
    const peers: { peer: WebRtcPeer; node: CascadeNode; did: string }[] = [];

    try {
      cluster = await startCluster({
        nodeCount: 4,
        maxParticipantsPerNode: MAX_PER_NODE,
        basePort: 13200,
      });

      const didToNode = new Map<string, CascadeNode>();
      for (const n of cluster.nodes) {
        didToNode.set(n.did, n);
        await n.client.call("sfu.startRoom", {
          neighbourhoodUrl: NEIGHBOURHOOD,
          roomName: ROOM_NAME,
        });
      }

      const nodeA = cluster.nodes[0];
      const counts: Record<string, number> = {};
      cluster.nodes.forEach((n) => (counts[n.did] = 0));

      for (let i = 0; i < PEER_COUNT; i++) {
        const peer = new WebRtcPeer(`s2-peer-${i}`, { audioToneHz: 440 + (i % 30) * 10 });
        await peer.attachSyntheticStream();
        const did = `did:windtunnel:s2:peer-${i}`;
        const offer = await peer.createOffer();

        let landed: CascadeNode = nodeA;
        let session = await nodeA.client.call<{
          sdpAnswer: string;
          participantId: string;
          redirectTo?: string;
          streamMapping: string[];
        }>("sfu.callJoin", {
          neighbourhoodUrl: NEIGHBOURHOOD,
          roomName: ROOM_NAME,
          sdpOffer: JSON.stringify(offer),
          agentDidOverride: did,
        });
        let hops = 1;
        while (session.redirectTo) {
          const target = didToNode.get(session.redirectTo);
          if (!target) throw new Error(`S2 peer ${i} redirectTo unknown ${session.redirectTo}`);
          hops++;
          if (hops > cluster.nodes.length + 1) {
            throw new Error(`S2 peer ${i} bounced ${hops} times — cascade cycle`);
          }
          session = await target.client.call<{
            sdpAnswer: string;
            participantId: string;
            redirectTo?: string;
            streamMapping: string[];
          }>("sfu.callJoin", {
            neighbourhoodUrl: NEIGHBOURHOOD,
            roomName: ROOM_NAME,
            sdpOffer: JSON.stringify(offer),
            agentDidOverride: did,
          });
          landed = target;
        }
        await peer.acceptAnswer(JSON.parse(session.sdpAnswer));
        peers.push({ peer, node: landed, did });
        counts[landed.did]++;
        await cluster.announceCount(
          landed,
          `${NEIGHBOURHOOD}:${ROOM_NAME}`,
          counts[landed.did],
        );
      }

      metrics["participantsPerNode"] = counts;
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const maxPerNodeActual = Math.max(...Object.values(counts));
      const minPerNodeActual = Math.min(...Object.values(counts));
      metrics["totalLanded"] = total;
      metrics["maxPerNodeActual"] = maxPerNodeActual;
      metrics["minPerNodeActual"] = minPerNodeActual;
      metrics["distributionOk"] = total === PEER_COUNT && maxPerNodeActual <= MAX_PER_NODE;

      samples.push({
        name: "s2_cascade_join_window",
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      });
    } finally {
      for (const { peer, node, did } of peers) {
        try {
          await node.client.call("sfu.callLeave", {
            neighbourhoodUrl: NEIGHBOURHOOD,
            roomName: ROOM_NAME,
            agentDidOverride: did,
          });
        } catch {}
        try {
          await peer.close();
        } catch {}
      }
      if (cluster) {
        try {
          await cluster.shutdown();
        } catch {}
      }
    }

    const endTime = Date.now();
    return {
      scenario: "s2-sfu-cascade-4node",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary:
        `S2: 4-node cascade — peers=${PEER_COUNT}, total=${metrics["totalLanded"]}, ` +
        `[min=${metrics["minPerNodeActual"]}, max=${metrics["maxPerNodeActual"]}] ` +
        `(ok=${metrics["distributionOk"]})`,
    };
  },
};

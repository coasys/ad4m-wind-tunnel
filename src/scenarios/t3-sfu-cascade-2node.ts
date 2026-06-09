/**
 * T3: Cascaded 2-node × 8 peers.
 *
 * Spin up two SFU executors (`startCluster({nodeCount: 2,
 * maxParticipantsPerNode: 4})`) and direct 8 peers at node A.  The
 * cascade redirect logic should kick in:
 *
 *  - Peers 1-4: join node A directly (no `redirectTo`).
 *  - Peers 5-8: receive `redirectTo: node-B-did`.  The wind tunnel
 *    follows the redirect by issuing a fresh `sfu.callJoin` against
 *    node B and records the second-hop success.
 *
 * What we measure on this pass:
 *  - First-hop join time (peer→node A).
 *  - Redirect rate (peers 5-8 should all get redirected).
 *  - Second-hop join time on node B.
 *  - Per-node `sfu.listRooms` participant count: A=4, B=4.
 *
 * What we deliberately don't measure here:
 *  - Cross-node RTP forwarding (pipe transport) — out of scope for
 *    this pass.  The SFU forwards per-node; redirect proves the
 *    decision layer, not the media layer.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { WebRtcPeer } from "../peer.js";
import { startCluster, CascadeNode } from "../cascade.js";

const ROOM_NAME = "t3-sfu-cascade-2node";
const NEIGHBOURHOOD = `windtunnel://t3`;
const PEER_COUNT = 8;
const MAX_PER_NODE = 4;

export const t3SfuCascade2Node: Scenario = {
  id: "t3",
  name: "Cascaded 2-node × 8 peers",
  description: "Two SFU nodes, 8 peers; peer 5+ redirected to node B via cascade decision",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const metrics: Record<string, unknown> = {};

    let cluster: Awaited<ReturnType<typeof startCluster>> | null = null;
    const peers: { peer: WebRtcPeer; node: CascadeNode; did: string }[] = [];

    try {
      cluster = await startCluster({
        nodeCount: 2,
        maxParticipantsPerNode: MAX_PER_NODE,
        // Don't collide with the main wind-tunnel executor on 12000.
        basePort: 13000,
      });
      const [nodeA, nodeB] = cluster.nodes;
      metrics["nodeA"] = nodeA.did;
      metrics["nodeB"] = nodeB.did;

      // Start a room on node A; peers redirected to B will start a room
      // on B implicitly during their second-hop join.
      await nodeA.client.call("sfu.startRoom", {
        neighbourhoodUrl: NEIGHBOURHOOD,
        roomName: ROOM_NAME,
      });
      await nodeB.client.call("sfu.startRoom", {
        neighbourhoodUrl: NEIGHBOURHOOD,
        roomName: ROOM_NAME,
      });

      const redirectCount: { fromA: number; toB: number } = { fromA: 0, toB: 0 };

      const didToNode = new Map<string, CascadeNode>([
        [nodeA.did, nodeA],
        [nodeB.did, nodeB],
      ]);

      for (let i = 0; i < PEER_COUNT; i++) {
        const peer = new WebRtcPeer(`t3-peer-${i}`, { audioToneHz: 440 + i * 30 });
        await peer.attachSyntheticStream();
        const did = `did:windtunnel:t3:peer-${i}`;
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

        const seen = new Set<string>([nodeA.did]);
        let hops = 1;
        while (session.redirectTo) {
          if (seen.has(session.redirectTo)) {
            throw new Error(
              `T3 peer ${i} cascade cycle — seen=${[...seen].join(",")} redirect_to=${session.redirectTo}`,
            );
          }
          seen.add(session.redirectTo);
          redirectCount.fromA++;
          if (session.redirectTo === nodeB.did) redirectCount.toB++;
          const target = didToNode.get(session.redirectTo);
          if (!target) {
            throw new Error(`T3 peer ${i} redirect to unknown DID ${session.redirectTo}`);
          }
          hops++;
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

        samples.push({
          name: `t3_peer_${i}_landed_${landed.id}_hops_${hops}`,
          durationMs: 0,
          timestamp: Date.now(),
        });
        await peer.acceptAnswer(JSON.parse(session.sdpAnswer));
        peers.push({ peer, node: landed, did });
        // Keep peer counts fresh across the cluster (see T4 / cascade.ts).
        const landedCount = peers.filter((p) => p.node.id === landed.id).length;
        await cluster.announceCount(landed, `${NEIGHBOURHOOD}:${ROOM_NAME}`, landedCount);
      }

      metrics["redirectFromA"] = redirectCount.fromA;
      metrics["redirectToB"] = redirectCount.toB;

      // Settle + check per-node room state.
      await new Promise<void>((r) => setTimeout(r, 500));
      const roomsA = await nodeA.client.call<
        Array<{ roomName: string; participantCount: number }>
      >("sfu.listRooms", {});
      const roomsB = await nodeB.client.call<
        Array<{ roomName: string; participantCount: number }>
      >("sfu.listRooms", {});
      metrics["nodeAParticipants"] =
        roomsA.find((r) => r.roomName === ROOM_NAME)?.participantCount ?? -1;
      metrics["nodeBParticipants"] =
        roomsB.find((r) => r.roomName === ROOM_NAME)?.participantCount ?? -1;
      metrics["peersPerNodeBalanced"] =
        metrics["nodeAParticipants"] === MAX_PER_NODE &&
        metrics["nodeBParticipants"] === PEER_COUNT - MAX_PER_NODE;
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
      scenario: "t3-sfu-cascade-2node",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary:
        `T3: cascade — peers=${PEER_COUNT}, A=${metrics["nodeAParticipants"]}, ` +
        `B=${metrics["nodeBParticipants"]}, redirects=${metrics["redirectFromA"]} ` +
        `(balanced=${metrics["peersPerNodeBalanced"]})`,
    };
  },
};

/**
 * T4: Cascaded 3-node × 12 peers.
 *
 * Same shape as T3 with 3 nodes and 12 peers.  Confirms
 * `pick_redirect_node` distributes load across more than two nodes:
 * each node should land 4 peers (12 / 3).
 *
 * The wind tunnel iterates peers against node A.  When A returns
 * `redirectTo`, the wind tunnel obeys: it re-issues `sfu.callJoin`
 * against whichever node is named in `redirectTo`, and that node
 * accepts the peer.  Peers split across A/B/C based on the cascade
 * decision at the moment they joined.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { WebRtcPeer } from "../peer.js";
import { startCluster, CascadeNode } from "../cascade.js";

const ROOM_NAME = "t4-sfu-cascade-3node";
const NEIGHBOURHOOD = `windtunnel://t4`;
const PEER_COUNT = 12;
const MAX_PER_NODE = 4;

export const t4SfuCascade3Node: Scenario = {
  id: "t4",
  name: "Cascaded 3-node × 12 peers",
  description: "Three SFU nodes, 12 peers; confirms least-loaded distribution",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const metrics: Record<string, unknown> = {};

    let cluster: Awaited<ReturnType<typeof startCluster>> | null = null;
    const peers: { peer: WebRtcPeer; node: CascadeNode; did: string }[] = [];

    try {
      cluster = await startCluster({
        nodeCount: 3,
        maxParticipantsPerNode: MAX_PER_NODE,
        basePort: 13100,
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
      const redirectCounts: Record<string, number> = {};

      for (let i = 0; i < PEER_COUNT; i++) {
        const peer = new WebRtcPeer(`t4-peer-${i}`, { audioToneHz: 440 + i * 20 });
        await peer.attachSyntheticStream();
        const did = `did:windtunnel:t4:peer-${i}`;
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
          redirectCounts[session.redirectTo] =
            (redirectCounts[session.redirectTo] ?? 0) + 1;
          const target = didToNode.get(session.redirectTo);
          if (!target) {
            throw new Error(`T4 peer ${i} redirectTo unknown did=${session.redirectTo}`);
          }
          hops++;
          if (hops > cluster.nodes.length) {
            throw new Error(`T4 peer ${i} bounced ${hops} times — cycle detected`);
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
        // Keep every OTHER node's cascade view fresh: tell them that
        // `landed` now has counts[landed.did] participants.  Without
        // this update the cluster looks like all nodes have 0 from
        // each others' view and redirects bounce.
        await cluster.announceCount(
          landed,
          `${NEIGHBOURHOOD}:${ROOM_NAME}`,
          counts[landed.did],
        );
        samples.push({
          name: `t4_peer_${i}_landed_${landed.id}_hops_${hops}`,
          durationMs: 0,
          timestamp: Date.now(),
        });
      }

      metrics["participantsPerNode"] = counts;
      metrics["redirectsByTargetDid"] = redirectCounts;

      // Verify server-reported counts match what the harness saw.
      await new Promise<void>((r) => setTimeout(r, 500));
      const serverCounts: Record<string, number> = {};
      for (const n of cluster.nodes) {
        const rooms = await n.client.call<
          Array<{ roomName: string; participantCount: number }>
        >("sfu.listRooms", {});
        serverCounts[n.did] = rooms.find((r) => r.roomName === ROOM_NAME)?.participantCount ?? -1;
      }
      metrics["serverParticipantsPerNode"] = serverCounts;

      // Quality of distribution — total should equal PEER_COUNT and
      // no node should exceed MAX_PER_NODE.
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const maxPerNodeActual = Math.max(...Object.values(counts));
      metrics["totalLanded"] = total;
      metrics["maxPerNodeActual"] = maxPerNodeActual;
      metrics["distributionOk"] = total === PEER_COUNT && maxPerNodeActual <= MAX_PER_NODE;
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
      scenario: "t4-sfu-cascade-3node",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary:
        `T4: 3-node cascade — peers=${PEER_COUNT}, landed=${metrics["totalLanded"]}, ` +
        `max-per-node=${metrics["maxPerNodeActual"]} (ok=${metrics["distributionOk"]})`,
    };
  },
};

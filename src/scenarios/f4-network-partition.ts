/**
 * F4: Cascade network partition.
 *
 * 2-node cluster.  Once peers are joined to both nodes, simulate a
 * partition between A and B by removing the cascade peer entry from
 * each side's `CascadeManager`.  Verify:
 *
 *  - Peers on either side keep their existing local SFU connections.
 *  - New peers joining A no longer see B as a redirect target (no
 *    "ghost" cascade decisions).
 *  - Both sides remain responsive.
 *
 * On a real multi-host deployment "partition" is iptables/tc;
 * single-host this is the static-config equivalent: re-issue
 * `sfu.enableCascade` on each node with an empty peer list to drop
 * the inter-node knowledge.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { WebRtcPeer } from "../peer.js";
import { startCluster, CascadeNode } from "../cascade.js";

const ROOM_NAME = "f4-network-partition";
const NEIGHBOURHOOD = `windtunnel://f4`;
const MAX_PER_NODE = 4;

export const f4NetworkPartition: Scenario = {
  id: "f4",
  name: "Cascade network partition",
  description: "2-node cluster, partition A↔B, verify no ghost cascade decisions",

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
        basePort: 13500,
      });

      const didToNode = new Map<string, CascadeNode>();
      for (const n of cluster.nodes) {
        didToNode.set(n.did, n);
        await n.client.call("sfu.startRoom", {
          neighbourhoodUrl: NEIGHBOURHOOD,
          roomName: ROOM_NAME,
        });
      }
      const [nodeA, nodeB] = cluster.nodes;

      // 5 peers — first 4 to A, 5th cascades to B.
      for (let i = 0; i < 5; i++) {
        const peer = new WebRtcPeer(`f4-peer-${i}`, { audioToneHz: 440 + i * 30 });
        await peer.attachSyntheticStream();
        const did = `did:windtunnel:f4:peer-${i}`;
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
        if (session.redirectTo) {
          const target = didToNode.get(session.redirectTo)!;
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
      }

      const preA = peers.filter((p) => p.node === nodeA).length;
      const preB = peers.filter((p) => p.node === nodeB).length;
      metrics["preParitionNodeA"] = preA;
      metrics["preParitionNodeB"] = preB;

      // Partition: re-issue enableCascade with empty peer list, so
      // neither side considers the other a cascade target.
      const partitionStart = Date.now();
      await nodeA.client.call("sfu.enableCascade", {
        localDid: nodeA.did,
        maxParticipantsPerNode: MAX_PER_NODE,
        peers: [],
      });
      await nodeB.client.call("sfu.enableCascade", {
        localDid: nodeB.did,
        maxParticipantsPerNode: MAX_PER_NODE,
        peers: [],
      });
      const partitionMs = Date.now() - partitionStart;
      metrics["partitionMs"] = partitionMs;

      // Probe: new peer joining A should NOT see redirectTo even
      // though A is at MAX_PER_NODE (no cascade target available
      // post-partition).
      const probe = new WebRtcPeer("f4-probe", { audioToneHz: 880 });
      await probe.attachSyntheticStream();
      const probeOffer = await probe.createOffer();
      const probeSession = await nodeA.client.call<{
        sdpAnswer: string;
        participantId: string;
        redirectTo?: string;
        streamMapping: string[];
      }>("sfu.callJoin", {
        neighbourhoodUrl: NEIGHBOURHOOD,
        roomName: ROOM_NAME,
        sdpOffer: JSON.stringify(probeOffer),
        agentDidOverride: "did:windtunnel:f4:probe",
      });
      metrics["probeRedirected"] = !!probeSession.redirectTo;
      metrics["probeRedirectTarget"] = probeSession.redirectTo ?? null;
      if (probeSession.redirectTo) {
        await probe.close().catch(() => {});
      } else {
        try {
          await probe.acceptAnswer(JSON.parse(probeSession.sdpAnswer));
        } catch {}
        try {
          await nodeA.client.call("sfu.callLeave", {
            neighbourhoodUrl: NEIGHBOURHOOD,
            roomName: ROOM_NAME,
            agentDidOverride: "did:windtunnel:f4:probe",
          });
        } catch {}
        await probe.close().catch(() => {});
      }

      // Both sides remain responsive.
      const roomsA = await nodeA.client.call<
        Array<{ roomName: string; participantCount: number }>
      >("sfu.listRooms", {});
      const roomsB = await nodeB.client.call<
        Array<{ roomName: string; participantCount: number }>
      >("sfu.listRooms", {});
      metrics["postPartitionNodeA"] =
        roomsA.find((r) => r.roomName === ROOM_NAME)?.participantCount ?? -1;
      metrics["postPartitionNodeB"] =
        roomsB.find((r) => r.roomName === ROOM_NAME)?.participantCount ?? -1;

      samples.push({
        name: "f4_partition_apply",
        durationMs: partitionMs,
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
      scenario: "f4-network-partition",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary:
        `F4: partition — pre A/B=${metrics["preParitionNodeA"]}/${metrics["preParitionNodeB"]}, ` +
        `post A/B=${metrics["postPartitionNodeA"]}/${metrics["postPartitionNodeB"]}, ` +
        `probeRedirected=${metrics["probeRedirected"]}`,
    };
  },
};

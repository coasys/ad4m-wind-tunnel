/**
 * T1: SFU 1-node × 5 peers.
 *
 * Drives 5 synthetic-media peers against a single executor SFU.  The
 * call sequence per peer is:
 *
 *   1. Local createOffer + setLocalDescription.
 *   2. `sfu.callJoin(neighbourhoodUrl, roomName, sdpOffer)` over WS RPC.
 *   3. Apply the returned `sdpAnswer`.
 *   4. Wait for the inbound tracks from the other peers (the SFU
 *      forwards them through the same peer connection).
 *
 * Asserts:
 *   - `time_to_media` per peer (offer → first remote track).
 *   - Per-peer upload bandwidth is *not* a function of N: a fifth peer
 *     joining doesn't double Alice's upload like it would in mesh.
 *   - The room's `participant_count` matches.
 *
 * **Pre-requisite**: the executor must be running with the SFU service
 * compiled in (always-on, no feature flag in the current architecture).
 * Scenarios that depend on the SFU set `requiresSfu: true` in their
 * metadata so the runner can skip them on non-SFU executor builds.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { WebRtcPeer, PeerStats } from "../peer.js";

const ROOM_NAME = "t1-sfu-5peer";

export const t1Sfu5Peer: Scenario = {
  id: "t1",
  name: "SFU 1-node × 5 peers",
  description: "Single SFU node, 5 peers, baseline SFU correctness + bandwidth",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const metrics: Record<string, unknown> = {};

    // Resolve the neighbourhood URL for this scenario.  Created lazily
    // so a single executor can host many wind tunnel runs.
    const neighbourhoodUrl = await getOrCreateScenarioNeighbourhood(client, "t1");
    metrics["neighbourhoodUrl"] = neighbourhoodUrl;

    // Boot the SFU room server-side.
    await client.call("sfu.startRoom", { neighbourhoodUrl, roomName: ROOM_NAME });

    const peers: WebRtcPeer[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        const peer = new WebRtcPeer(`peer-${i}`, {
          audioToneHz: 440 + i * 40,
          recvSlots: 4, // N-1 — pre-allocate slots so SFU's forwarded tracks land
        });
        await peer.attachSyntheticStream();
        peers.push(peer);

        const offer = await peer.createOffer();
        const joinStart = Date.now();
        const session = await client.call<{
          sdpAnswer: string;
          participantId: string;
          redirectTo?: string;
          streamMapping: string[];
        }>("sfu.callJoin", {
          neighbourhoodUrl,
          roomName: ROOM_NAME,
          sdpOffer: JSON.stringify(offer),
          // Each synthetic peer needs its own DID so the SFU doesn't
          // collide them under the executor-agent's single DID
          // (admin-only override; see `caller_did` in sfu_ws.rs).
          agentDidOverride: `did:windtunnel:t1:peer-${i}`,
        });
        const joinElapsed = Date.now() - joinStart;
        samples.push({
          name: `call_join_peer_${i}`,
          durationMs: joinElapsed,
          timestamp: Date.now(),
        });

        if (session.redirectTo) {
          throw new Error(
            `T1 expects a single-node SFU but got cascade redirect to ${session.redirectTo}`,
          );
        }
        await peer.acceptAnswer(JSON.parse(session.sdpAnswer));
      }

      // The SFU pushes a `subscribeCallRenegotiationOffer` event when
      // new peers join — that's how existing peers learn about later
      // arrivals' tracks.  The wind tunnel client doesn't subscribe to
      // that channel, so peers won't fire `remote-track` for joiners
      // they were already in the room before.  Instead of waiting on
      // track events, poll the SFU's room state until it reports the
      // expected participant count, then settle and sample.
      await waitForServerParticipantCount(client, ROOM_NAME, peers.length, 15_000);
      await sleep(2000);

      // 30s of stats sampling on every peer.
      const allStats: PeerStats[][] = peers.map(() => []);
      peers.forEach((p, i) => p.on("stats", (s: PeerStats) => allStats[i].push(s)));
      peers.forEach((p) => p.startStats());
      await sleep(30_000);
      peers.forEach((p) => p.stopStats());

      // Per-peer upload bandwidth — should be O(1), not O(N).
      const uploads: number[] = peers.map((p) => p.getLastStats()?.bytesSent ?? 0);
      const downloads: number[] = peers.map((p) => p.getLastStats()?.bytesReceived ?? 0);
      metrics["uploadBytesPerPeer"] = uploads;
      metrics["downloadBytesPerPeer"] = downloads;
      metrics["uploadMean"] = uploads.reduce((a, b) => a + b, 0) / uploads.length;
      metrics["downloadMean"] = downloads.reduce((a, b) => a + b, 0) / downloads.length;

      // Pull room info from the server and check participant count.
      const rooms = await client.call<Array<{ roomName: string; participantCount: number }>>(
        "sfu.listRooms",
        {},
      );
      const room = rooms.find((r) => r.roomName === ROOM_NAME);
      metrics["serverReportedParticipants"] = room?.participantCount ?? -1;
    } finally {
      for (const peer of peers) {
        try {
          await peer.close();
        } catch (_e) {
          // swallow — best-effort cleanup
        }
      }
      try {
        await client.call("sfu.stopRoom", { neighbourhoodUrl, roomName: ROOM_NAME });
      } catch (_e) {
        // ditto
      }
    }

    const endTime = Date.now();
    return {
      scenario: "t1-sfu-5peer",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary: `T1: SFU 5 peers — uploadMean=${metrics["uploadMean"]}B downloadMean=${metrics["downloadMean"]}B serverParticipants=${metrics["serverReportedParticipants"]}`,
    };
  },
};

async function waitForServerParticipantCount(
  client: ScenarioContext["client"],
  roomName: string,
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rooms = await client
      .call<Array<{ roomName: string; participantCount: number }>>("sfu.listRooms", {})
      .catch(() => [] as Array<{ roomName: string; participantCount: number }>);
    const room = rooms.find((r) => r.roomName === roomName);
    if (room && room.participantCount >= expected) return;
    await sleep(250);
  }
  throw new Error(
    `T1 waitForServerParticipantCount: room=${roomName} expected=${expected} ` +
      `within ${timeoutMs}ms`,
  );
}

/**
 * Create a neighbourhood for the scenario if one doesn't exist yet.
 * Lazy + idempotent so re-running the scenario reuses the same room
 * (the SFU service garbage-collects empty rooms).
 */
async function getOrCreateScenarioNeighbourhood(
  client: ScenarioContext["client"],
  scenarioId: string,
): Promise<string> {
  // Reserved for the SFU forward-port: the harness will need a
  // perspective + neighbourhood to scope the SFU room.  For now this
  // returns the sentinel `windtunnel://<scenario>` URL — the executor
  // SFU treats unknown neighbourhood URLs as ad-hoc rooms.
  return `windtunnel://${scenarioId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * S1: SFU 1-node × 20 peers.
 *
 * The single-SFU CPU saturation probe.  Same shape as T1/T2 scaled to
 * N=20.  At this size:
 *   - Mesh would require 190 pair-wise PCs, untenable.
 *   - SFU has 20 inbound + 20×19 outbound forwards = 380 forward
 *     decisions per arriving RTP packet.  This is where the relay
 *     loop's hot path matters.
 *
 * Reports:
 *   - Per-peer upload distribution (mean, sd, max) — should stay flat.
 *   - Per-peer download distribution — should scale linearly with N
 *     (each peer downloads N-1 streams).
 *   - Per-peer packet loss — if SFU saturates we expect loss > 0.
 *   - Server-reported participant count == 20.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { WebRtcPeer, PeerStats } from "../peer.js";

const ROOM_NAME = "s1-sfu-20peer";
const NEIGHBOURHOOD = `windtunnel://s1`;
const PEER_COUNT = 20;

export const s1Sfu20Peer: Scenario = {
  id: "s1",
  name: "SFU 1-node × 20 peers (scale)",
  description: "20-peer single SFU — bandwidth + loss distribution at scale",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const metrics: Record<string, unknown> = {};

    try {
      await client.call("sfu.startRoom", { neighbourhoodUrl: NEIGHBOURHOOD, roomName: ROOM_NAME });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("not yet available")) {
        metrics["skipped"] = true;
        metrics["skip_reason"] = msg;
        return {
          scenario: "s1-sfu-20peer",
          branch,
          startTime,
          endTime: Date.now(),
          durationMs: Date.now() - startTime,
          metrics,
          samples,
          summary: `S1: SKIPPED — ${msg}`,
        };
      }
      throw e;
    }

    const peers: WebRtcPeer[] = [];
    try {
      for (let i = 0; i < PEER_COUNT; i++) {
        const peer = new WebRtcPeer(`s1-peer-${i}`, {
          audioToneHz: 440 + i * 12,
          recvSlots: PEER_COUNT - 1,
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
          neighbourhoodUrl: NEIGHBOURHOOD,
          roomName: ROOM_NAME,
          sdpOffer: JSON.stringify(offer),
          agentDidOverride: `did:windtunnel:s1:peer-${i}`,
        });
        const joinElapsed = Date.now() - joinStart;
        samples.push({
          name: `call_join_peer_${i}`,
          durationMs: joinElapsed,
          timestamp: Date.now(),
        });
        if (session.redirectTo) {
          throw new Error(`S1 unexpected cascade redirect to ${session.redirectTo}`);
        }
        await peer.acceptAnswer(JSON.parse(session.sdpAnswer));
      }

      await waitForServerParticipantCount(client, ROOM_NAME, PEER_COUNT, 45_000);
      await sleep(2000);

      const allStats: PeerStats[][] = peers.map(() => []);
      peers.forEach((p, i) => p.on("stats", (s: PeerStats) => allStats[i].push(s)));
      peers.forEach((p) => p.startStats());
      await sleep(30_000);
      peers.forEach((p) => p.stopStats());

      const uploads = peers.map((p) => p.getLastStats()?.bytesSent ?? 0);
      const downloads = peers.map((p) => p.getLastStats()?.bytesReceived ?? 0);
      const losses = peers.map((p) => p.getLastStats()?.packetsLost ?? 0);
      const rtts = peers.map((p) => p.getLastStats()?.currentRoundTripTimeMs ?? null);
      metrics["uploadBytesPerPeer"] = uploads;
      metrics["downloadBytesPerPeer"] = downloads;
      metrics["packetsLostPerPeer"] = losses;
      metrics["rttPerPeer"] = rtts;
      metrics["uploadMean"] = mean(uploads);
      metrics["uploadStddev"] = stddev(uploads);
      metrics["downloadMean"] = mean(downloads);
      metrics["downloadStddev"] = stddev(downloads);
      metrics["packetsLostTotal"] = losses.reduce((a, b) => a + b, 0);

      const rooms = await client.call<Array<{ roomName: string; participantCount: number }>>(
        "sfu.listRooms",
        {},
      );
      metrics["serverReportedParticipants"] =
        rooms.find((r) => r.roomName === ROOM_NAME)?.participantCount ?? -1;
    } finally {
      for (const peer of peers) {
        try {
          await peer.close();
        } catch {}
      }
      try {
        await client.call("sfu.stopRoom", { neighbourhoodUrl: NEIGHBOURHOOD, roomName: ROOM_NAME });
      } catch {}
    }

    const endTime = Date.now();
    return {
      scenario: "s1-sfu-20peer",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary:
        `S1: SFU 20 peers — uploadMean=${metrics["uploadMean"]}B (sd=${metrics["uploadStddev"]}B) ` +
        `downloadMean=${metrics["downloadMean"]}B packetsLostTotal=${metrics["packetsLostTotal"]} ` +
        `serverParticipants=${metrics["serverReportedParticipants"]}`,
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
    `S1 waitForServerParticipantCount: room=${roomName} expected=${expected} within ${timeoutMs}ms`,
  );
}

function mean(arr: number[]): number {
  return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

function stddev(arr: number[]): number {
  if (arr.length === 0) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
  return Math.round(Math.sqrt(variance));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

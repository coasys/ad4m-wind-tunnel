/**
 * T2: SFU 1-node × 10 peers.
 *
 * Same shape as T1 with N=10.  At this size:
 *   - Mesh would have 10*9/2 = 45 pairs (10×9=90 PCs) — clearly
 *     untenable.
 *   - SFU has 1 PC per peer; per-peer upload is O(1).
 *
 * Identifies the SFU's single-node bandwidth/CPU ceiling.  If T2
 * regresses heavily relative to T1, the SFU's media-relay loop is
 * the suspect.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { WebRtcPeer, PeerStats } from "../peer.js";

const ROOM_NAME = "t2-sfu-10peer";
const PEER_COUNT = 10;

export const t2Sfu10Peer: Scenario = {
  id: "t2",
  name: "SFU 1-node × 10 peers",
  description: "Same as T1 with N=10 — single-node SFU bandwidth/CPU ceiling check",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const metrics: Record<string, unknown> = {};

    const neighbourhoodUrl = `windtunnel://t2`;
    metrics["neighbourhoodUrl"] = neighbourhoodUrl;
    await client.call("sfu.startRoom", { neighbourhoodUrl, roomName: ROOM_NAME });

    const peers: WebRtcPeer[] = [];
    try {
      for (let i = 0; i < PEER_COUNT; i++) {
        const peer = new WebRtcPeer(`peer-${i}`, {
          audioToneHz: 440 + i * 20,
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
          neighbourhoodUrl,
          roomName: ROOM_NAME,
          sdpOffer: JSON.stringify(offer),
          agentDidOverride: `did:windtunnel:t2:peer-${i}`,
        });
        const joinElapsed = Date.now() - joinStart;
        samples.push({
          name: `call_join_peer_${i}`,
          durationMs: joinElapsed,
          timestamp: Date.now(),
        });

        if (session.redirectTo) {
          throw new Error(
            `T2 expects a single-node SFU but got cascade redirect to ${session.redirectTo}`,
          );
        }
        await peer.acceptAnswer(JSON.parse(session.sdpAnswer));
      }

      await waitForServerParticipantCount(client, ROOM_NAME, PEER_COUNT, 30_000);
      await sleep(2000);

      const allStats: PeerStats[][] = peers.map(() => []);
      peers.forEach((p, i) => p.on("stats", (s: PeerStats) => allStats[i].push(s)));
      peers.forEach((p) => p.startStats());
      await sleep(30_000);
      peers.forEach((p) => p.stopStats());

      const uploads = peers.map((p) => p.getLastStats()?.bytesSent ?? 0);
      const downloads = peers.map((p) => p.getLastStats()?.bytesReceived ?? 0);
      metrics["uploadBytesPerPeer"] = uploads;
      metrics["downloadBytesPerPeer"] = downloads;
      metrics["uploadMean"] = mean(uploads);
      metrics["downloadMean"] = mean(downloads);
      metrics["uploadStddev"] = stddev(uploads);
      metrics["downloadStddev"] = stddev(downloads);

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
        } catch {}
      }
      try {
        await client.call("sfu.stopRoom", { neighbourhoodUrl, roomName: ROOM_NAME });
      } catch {}
    }

    const endTime = Date.now();
    return {
      scenario: "t2-sfu-10peer",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary:
        `T2: SFU 10 peers — uploadMean=${metrics["uploadMean"]}B (sd=${metrics["uploadStddev"]}B) ` +
        `downloadMean=${metrics["downloadMean"]}B serverParticipants=${metrics["serverReportedParticipants"]}`,
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
    `T2 waitForServerParticipantCount: room=${roomName} expected=${expected} within ${timeoutMs}ms`,
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

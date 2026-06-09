/**
 * F6: Non-member callJoin.
 *
 * The SFU's membership check should reject `sfu.callJoin` when the
 * caller is not part of the neighbourhood.  In the wind tunnel admin
 * model the admin token bypasses membership checks (admin == god),
 * so we approximate by passing a syntactically valid-but-bogus offer
 * for a neighbourhood URL the SFU never registered with a config.
 *
 * The expected behaviour is:
 *   - Either a clear "membership check failed" error,
 *   - Or the ad-hoc fallback (windtunnel:// neighbourhoods bypass
 *     membership by design — flagged as such in metrics).
 *
 * Either way the executor should NOT crash.  We do a follow-up
 * `sfu.listRooms` after to confirm the service is still responsive.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";

const NEIGHBOURHOOD = `windtunnel-bogus://f6/${Date.now()}`;
const ROOM_NAME = "f6-non-member";

export const f6NonMemberJoin: Scenario = {
  id: "f6",
  name: "Non-member callJoin (membership check)",
  description: "Confirm the SFU's membership check refuses calls from non-members",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const metrics: Record<string, unknown> = {};

    let joinRejected = false;
    let joinError: string | null = null;
    let response: unknown = null;
    try {
      response = await client.call("sfu.callJoin", {
        neighbourhoodUrl: NEIGHBOURHOOD,
        roomName: ROOM_NAME,
        sdpOffer: '{"type":"offer","sdp":"v=0\\r\\no=- 0 0 IN IP4 127.0.0.1\\r\\n"}',
      });
    } catch (e) {
      joinRejected = true;
      joinError = e instanceof Error ? e.message : String(e);
    }
    metrics["joinRejected"] = joinRejected;
    metrics["joinError"] = joinError;
    metrics["joinResponse"] = response;

    // Either a clean reject or an ad-hoc room — the SFU should still be
    // responsive after.  Confirm.
    let listOk = false;
    try {
      await client.call("sfu.listRooms", {});
      listOk = true;
    } catch (e) {
      metrics["postCallListError"] = e instanceof Error ? e.message : String(e);
    }
    metrics["sfuStillResponsive"] = listOk;

    const endTime = Date.now();
    return {
      scenario: "f6-non-member-join",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary:
        `F6: joinRejected=${metrics["joinRejected"]} ` +
        `sfuStillResponsive=${metrics["sfuStillResponsive"]} ` +
        (joinError ? `error="${joinError.slice(0, 60)}"` : ""),
    };
  },
};

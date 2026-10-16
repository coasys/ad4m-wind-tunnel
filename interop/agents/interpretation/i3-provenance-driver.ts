/**
 * I3 — provenance overlay + the §4 human-divergence gate.
 *
 * Run once (LLM creates an instance -> real == inferred, overlay kind=create).
 * A human edits one property directly through the client. Re-run with a
 * transcript that proposes a DIVERGENT value for that same property AND a
 * fresh value for an untouched property in the SAME call:
 *   - the human-edited property must stay untouched (real), with the LLM's new
 *     value staged as an overlay-only suggestion;
 *   - the untouched (still LLM-owned) property must update normally.
 *
 * Mirrors ad4m-interp's `interpretation/overlay/gate.rs` doc comment and its
 * `human_edited_value_is_protected_overlay_only_gets_suggestion` unit test.
 * One important, easy-to-get-wrong detail: `write_overlay` (`overlay/write.rs`)
 * keeps an overlay's ORIGINAL `kind` across passes — a create-kind overlay
 * stays `kind:"create"` even once it starts carrying a gated update
 * suggestion. This driver asserts that explicitly, not "update".
 *
 * Env: WS_HOST/WS_PORT (executor WS-RPC), ADMIN (token), MOCK_HOST/MOCK_PORT.
 */
import { InterpClient, registerInterpretationModel, waitForExecutorHealth, waitForMockHealth } from "./interp-client.js";
import { registerModels, WT_TASK_OWNER, WT_TASK_TITLE } from "./models.js";
import { setInterpRules } from "./mock-control.js";
import { assertTrue, assertEqual, assertDefined } from "./assert.js";

const WS_HOST = process.env.WS_HOST || "127.0.0.1";
const WS_PORT = Number(process.env.WS_PORT || 0);
const ADMIN = process.env.ADMIN || "windtunnel-admin";
const MOCK_HOST = process.env.MOCK_HOST || "127.0.0.1";
const MOCK_PORT = Number(process.env.MOCK_PORT || 0);
// Executor-facing mock URL (docker-network name), distinct from the host-published
// loopback the driver uses for control-plane calls. See registerInterpretationModel.
const MOCK_INTERNAL_URL = process.env.MOCK_INTERNAL_URL || `http://${MOCK_HOST}:${MOCK_PORT}/v1`;
const BASE_PREFIX = "wt://i3/";

function inferredValue(overlay: { inferred: [string, any][] }, predicate: string): any {
  const hit = overlay.inferred.find(([p]) => p === predicate);
  return hit ? hit[1] : undefined;
}

async function main() {
  assertTrue(!!WS_PORT && !!MOCK_PORT, "the caller must set WS_PORT and MOCK_PORT");
  await waitForExecutorHealth(WS_HOST, WS_PORT);
  await waitForMockHealth(MOCK_HOST, MOCK_PORT);

  const client = new InterpClient(WS_HOST, WS_PORT, ADMIN);
  await client.connect();
  console.log("[i3] connected to executor");

  const modelId = await registerInterpretationModel(client, MOCK_INTERNAL_URL);
  console.log(`[i3] registered interpretation model ${modelId}`);

  const persp = await client.createPerspective("i3-provenance");
  const uuid = persp.uuid;
  console.log(`[i3] perspective ${uuid}`);

  await registerModels(client, uuid, ["WtTask"]);

  // ---- Pass 1: LLM creates. real == inferred for every field. ----
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "create-release-notes-task",
      match: ["Priya", "release notes"],
      response: [{ class: "WtTask", title: "Draft the release notes", owner: "Priya" }],
    },
  ]);
  const transcript1 = [{ speaker: "Sam", text: "Priya, can you draft the release notes for this cycle?" }];
  const bases1 = await client.runInterpretation(uuid, transcript1, BASE_PREFIX, ["WtTask"]);
  assertTrue(bases1.length === 1, `expected 1 new instance, got ${bases1.length}`);
  const base = bases1[0];
  console.log(`[i3] pass 1 created ${base}`);

  let overlays = await client.interpretationOverlays(uuid);
  let overlay = overlays.find((o) => o.base === base);
  assertDefined(overlay, "a provenance overlay must exist immediately after a create pass");
  assertEqual(overlay.kind, "create", "overlay kind after the create pass");
  assertTrue(!!overlay.run && overlay.run.startsWith("ad4m://interp/run/"), `overlay.run must point at an ad4m://interp/run/ node, got ${overlay.run}`);
  assertEqual(inferredValue(overlay, WT_TASK_TITLE), "Draft the release notes", "inferred title after pass 1");
  assertEqual(inferredValue(overlay, WT_TASK_OWNER), "Priya", "inferred owner after pass 1");
  console.log("[i3] ok — create-pass overlay: kind=create, run under ad4m://interp/run/, inferred snapshot matches the written values");

  // ---- Human edits `owner` directly through the client (NOT the LLM). ----
  await client.setScalarProperty(uuid, base, WT_TASK_OWNER, "Devon");
  let rows = (await client.modelQuery(uuid, "WtTask", {})).instances;
  let row = rows.find((r: any) => r.id === base);
  assertDefined(row, "instance must still exist after the human edit");
  assertEqual(row.owner, "Devon", "owner immediately after the human edit");
  console.log("[i3] ok — human edited owner directly via the client (Priya -> Devon)");

  // ---- Pass 2: LLM proposes a DIVERGENT owner (Priya2, not knowing about the
  // human's Devon) AND a fresh title on the SAME (still-untouched) field. ----
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "propose-divergent-owner-plus-owned-title",
      match: ["publish", "release notes"],
      response: [{ class: "WtTask", id: base, title: "Draft and publish the release notes", owner: "Priya2" }],
    },
  ]);
  const transcript2 = [{ speaker: "Sam", text: "Let's also publish the release notes once they're drafted." }];
  await client.runInterpretation(uuid, transcript2, BASE_PREFIX, ["WtTask"]);

  // Real owner must stay UNTOUCHED (the human's value survives).
  rows = (await client.modelQuery(uuid, "WtTask", {})).instances;
  row = rows.find((r: any) => r.id === base);
  assertDefined(row, "instance must still exist after pass 2");
  assertEqual(row.owner, "Devon", "real owner must stay the human's value after a divergent LLM proposal");
  // Real title — the LLM still owns this field (never touched by a human) — must update normally.
  assertEqual(row.title, "Draft and publish the release notes", "real title must update (LLM still owns it)");
  console.log("[i3] ok — human-diverged owner untouched by pass 2; LLM-owned title updated normally");

  // The overlay stages the LLM's divergent owner suggestion; kind stays "create".
  overlays = await client.interpretationOverlays(uuid);
  overlay = overlays.find((o) => o.base === base);
  assertDefined(overlay, "overlay must still exist after pass 2");
  assertEqual(overlay.kind, "create", "overlay kind must remain 'create' across passes (write_overlay keeps the original kind)");
  assertEqual(inferredValue(overlay, WT_TASK_OWNER), "Priya2", "overlay must stage the LLM's divergent owner as a suggestion");
  assertEqual(inferredValue(overlay, WT_TASK_TITLE), "Draft and publish the release notes", "overlay's inferred title tracks the applied (still-owned) value");
  assertTrue(!!overlay.run && overlay.run.startsWith("ad4m://interp/run/"), `overlay.run after pass 2 must still sit under ad4m://interp/run/, got ${overlay.run}`);

  console.log(
    "[i3] PASS — human edit protected from a divergent re-run (overlay-only suggestion staged); a still-LLM-owned field updated normally in the same pass",
  );
  client.close();
}

main().catch((e) => {
  console.error(`[i3] FAIL — ${e?.stack || e}`);
  process.exit(1);
});

/**
 * I4 — human accept/reject of staged interpretation overlays.
 *
 * Builds three independent bases (fresh instances, each reaching the overlay
 * state it needs) and exercises all four corners of ad4m-interp's
 * `interpretation/overlay/accept.rs`:
 *
 *   Base A — reaches "I3 state" (create, then a human-diverged re-run), then
 *            resolution proceeds with:
 *     1. `acceptInterpretation(base, "wt://owner")` (property-scoped) — the
 *        staged suggestion MATERIALIZES onto the real value (accept explicitly
 *        overwrites the human's edit with the accepted suggestion — a
 *        human-initiated action). Mirrors `accept.rs`'s "update -> inferred
 *        becomes real".
 *     2. `acceptInterpretation(base)` (whole-base, no property) — the
 *        remaining (already-real-equals-inferred) title field carries no
 *        value change; the overlay shell disappears entirely either way.
 *        Mirrors "create -> overlay dropped" (nothing left to resolve).
 *   Base B — a plain create overlay, never touched by a human, whole-base
 *            REJECTED: `kind === "create"` -> `reject_interpretation` deletes
 *            the ENTIRE instance, not just the overlay. Mirrors "create ->
 *            base+overlay deleted".
 *   Base C — create, then human-diverged re-run (same shape as I3), then
 *            resolution proceeds with a PROPERTY-SCOPED reject on the diverged
 *            field: the suggestion drops away, the human's real value
 *            survives. Mirrors "update -> suggestion dropped".
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
const BASE_PREFIX = "wt://i4/";

async function main() {
  assertTrue(!!WS_PORT && !!MOCK_PORT, "the caller must set WS_PORT and MOCK_PORT");
  await waitForExecutorHealth(WS_HOST, WS_PORT);
  await waitForMockHealth(MOCK_HOST, MOCK_PORT);

  const client = new InterpClient(WS_HOST, WS_PORT, ADMIN);
  await client.connect();
  console.log("[i4] connected to executor");

  const modelId = await registerInterpretationModel(client, MOCK_INTERNAL_URL);
  console.log(`[i4] registered interpretation model ${modelId}`);

  const persp = await client.createPerspective("i4-accept-reject");
  const uuid = persp.uuid;
  console.log(`[i4] perspective ${uuid}`);

  await registerModels(client, uuid, ["WtTask"]);

  // =========================================================================
  // Base A — property-scoped accept (update -> inferred becomes real), then
  // whole-base accept (create-like remainder -> overlay dropped).
  // =========================================================================
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "a-create",
      match: ["Priya", "release notes"],
      response: [{ class: "WtTask", title: "Draft the release notes", owner: "Priya" }],
    },
  ]);
  const basesA = await client.runInterpretation(
    uuid,
    [{ speaker: "Sam", text: "Priya, can you draft the release notes for this cycle?" }],
    BASE_PREFIX,
    ["WtTask"],
  );
  assertTrue(basesA.length === 1, `Base A: expected 1 new instance, got ${basesA.length}`);
  const baseA = basesA[0];

  await client.setScalarProperty(uuid, baseA, WT_TASK_OWNER, "Devon"); // human diverges owner
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "a-divergent-update",
      match: ["publish", "release notes"],
      response: [{ class: "WtTask", id: baseA, title: "Draft and publish the release notes", owner: "Priya2" }],
    },
  ]);
  await client.runInterpretation(uuid, [{ speaker: "Sam", text: "Let's also publish the release notes." }], BASE_PREFIX, ["WtTask"]);

  let overlaysA = await client.interpretationOverlays(uuid);
  let overlayA = overlaysA.find((o) => o.base === baseA);
  assertDefined(overlayA, "Base A: overlay must exist before accept");
  console.log(`[i4] Base A ready: ${baseA} (owner suggestion pending: Priya2 vs real Devon)`);

  // 1. Property-scoped accept on `owner` — the suggestion overwrites the human edit.
  const acceptedOwner = await client.acceptInterpretation(uuid, baseA, WT_TASK_OWNER);
  assertTrue(acceptedOwner === true, "acceptInterpretation(owner) must return true");
  let rowsA = (await client.modelQuery(uuid, "WtTask", {})).instances;
  let rowA = rowsA.find((r: any) => r.id === baseA);
  assertDefined(rowA, "Base A must still exist after property-scoped accept");
  assertEqual(rowA.owner, "Priya2", "Base A: accepted owner suggestion must become the real value");
  overlaysA = await client.interpretationOverlays(uuid);
  overlayA = overlaysA.find((o) => o.base === baseA);
  assertDefined(overlayA, "Base A: overlay must still exist (title's suggestion stands untouched)");
  assertTrue(
    overlayA.inferred.every(([p]) => p !== WT_TASK_OWNER),
    "Base A: the accepted owner's inferred/<p> link must disappear",
  );
  console.log("[i4] ok — Base A property-scoped accept(owner): suggestion became real (update -> inferred becomes real)");

  // 2. Whole-base accept — resolves the remaining (already-real) title field and
  // deletes the overlay shell entirely (create-like: nothing visibly changes,
  // "overlay dropped").
  const acceptedRest = await client.acceptInterpretation(uuid, baseA);
  assertTrue(acceptedRest === true, "acceptInterpretation(whole base) must return true");
  rowsA = (await client.modelQuery(uuid, "WtTask", {})).instances;
  rowA = rowsA.find((r: any) => r.id === baseA);
  assertDefined(rowA, "Base A must still exist after whole-base accept");
  assertEqual(rowA.title, "Draft and publish the release notes", "Base A: title unchanged by the whole-base accept (already real==inferred)");
  overlaysA = await client.interpretationOverlays(uuid);
  assertTrue(!overlaysA.some((o) => o.base === baseA), "Base A: overlay must fully disappear after the whole-base accept");
  console.log("[i4] ok — Base A whole-base accept: overlay fully deleted, real values intact");

  // =========================================================================
  // Base B — plain create overlay, never touched by a human, whole-base
  // reject: this must delete the ENTIRE instance, not just the overlay.
  // =========================================================================
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "b-create",
      match: ["Sam", "changelog"],
      response: [{ class: "WtTask", title: "Update the changelog", owner: "Sam" }],
    },
  ]);
  const basesB = await client.runInterpretation(uuid, [{ speaker: "Priya", text: "Sam, update the changelog before we ship." }], BASE_PREFIX, ["WtTask"]);
  assertTrue(basesB.length === 1, `Base B: expected 1 new instance, got ${basesB.length}`);
  const baseB = basesB[0];
  const overlaysB0 = await client.interpretationOverlays(uuid);
  const overlayB0 = overlaysB0.find((o) => o.base === baseB);
  assertDefined(overlayB0, "Base B: overlay must exist before reject");
  assertEqual(overlayB0.kind, "create", "Base B: overlay kind must read 'create'");
  console.log(`[i4] Base B ready: ${baseB} (untouched create overlay)`);

  const rejectedB = await client.rejectInterpretation(uuid, baseB);
  assertTrue(rejectedB === true, "rejectInterpretation(whole base, create) must return true");
  const rowsB = (await client.modelQuery(uuid, "WtTask", {})).instances;
  assertTrue(!rowsB.some((r: any) => r.id === baseB), "Base B: a whole-base reject on a create overlay must FULLY delete the instance");
  const overlaysB1 = await client.interpretationOverlays(uuid);
  assertTrue(!overlaysB1.some((o) => o.base === baseB), "Base B: overlay must also disappear");
  console.log("[i4] ok — Base B whole-base reject on a create overlay: base + overlay both deleted");

  // =========================================================================
  // Base C — create, then human-diverged re-run (I3 shape), resolved with a
  // PROPERTY-SCOPED reject: suggestion dropped, human's real value preserved.
  // =========================================================================
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "c-create",
      match: ["Kai", "archive"],
      response: [{ class: "WtTask", title: "Archive old docs", owner: "Kai" }],
    },
  ]);
  const basesC = await client.runInterpretation(uuid, [{ speaker: "Priya", text: "Kai, please archive the old docs." }], BASE_PREFIX, ["WtTask"]);
  assertTrue(basesC.length === 1, `Base C: expected 1 new instance, got ${basesC.length}`);
  const baseC = basesC[0];

  await client.setScalarProperty(uuid, baseC, WT_TASK_OWNER, "Uma"); // human diverges owner
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "c-divergent-update",
      match: ["reassign", "archive"],
      response: [{ class: "WtTask", id: baseC, title: "Archive old docs", owner: "Zane" }],
    },
  ]);
  await client.runInterpretation(uuid, [{ speaker: "Priya", text: "Let's reassign the archive task." }], BASE_PREFIX, ["WtTask"]);

  let rowC = (await client.modelQuery(uuid, "WtTask", {})).instances.find((r: any) => r.id === baseC);
  assertDefined(rowC, "Base C must exist before reject");
  assertEqual(rowC.owner, "Uma", "Base C: sanity — real owner still holds the human's value before reject");
  console.log(`[i4] Base C ready: ${baseC} (owner suggestion pending: Zane vs real Uma)`);

  const rejectedOwnerC = await client.rejectInterpretation(uuid, baseC, WT_TASK_OWNER);
  assertTrue(rejectedOwnerC === true, "rejectInterpretation(owner) must return true");
  rowC = (await client.modelQuery(uuid, "WtTask", {})).instances.find((r: any) => r.id === baseC);
  assertDefined(rowC, "Base C must still exist after property-scoped reject");
  assertEqual(rowC.owner, "Uma", "Base C: real owner must stay the human's value after reject");
  const overlaysC = await client.interpretationOverlays(uuid);
  const overlayC = overlaysC.find((o) => o.base === baseC);
  if (overlayC) {
    assertTrue(overlayC.inferred.every(([p]) => p !== WT_TASK_OWNER), "Base C: the rejected owner's inferred/<p> link must disappear");
  }
  console.log("[i4] ok — Base C property-scoped reject(owner): suggestion dropped, human's real value preserved");

  console.log(
    "[i4] PASS — accept materializes a staged suggestion (update) and cleanly drops an already-real overlay (create); reject deletes a create wholesale and preserves a human-owned real value on an update",
  );
  client.close();
}

main().catch((e) => {
  console.error(`[i4] FAIL — ${e?.stack || e}`);
  process.exit(1);
});

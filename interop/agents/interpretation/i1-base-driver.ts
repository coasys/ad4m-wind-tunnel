/**
 * I1 — base interpretation loop.
 *
 * Register a subject class carrying interpretation hints (class-level + a
 * required identity property), run `perspective.runInterpretation` over a
 * transcript, assert the typed instance landed and reads back correctly through
 * the model layer, then re-run with a transcript that merely restates the same task
 * — the deterministic dedup safety net must drop it, not the model's good
 * behaviour (mirrors `run-interpretation.test.ts`'s dedup-on-re-run case).
 *
 * Env: WS_HOST/WS_PORT (executor WS-RPC), ADMIN (token), MOCK_HOST/MOCK_PORT.
 */
import { InterpClient, registerInterpretationModel, waitForExecutorHealth, waitForMockHealth } from "./interp-client.js";
import { registerModels, WT_TASK_TYPE, WT_TASK_TYPE_VALUE } from "./models.js";
import { setInterpRules } from "./mock-control.js";
import { assertTrue, assertEqual } from "./assert.js";

const WS_HOST = process.env.WS_HOST || "127.0.0.1";
const WS_PORT = Number(process.env.WS_PORT || 0);
const ADMIN = process.env.ADMIN || "windtunnel-admin";
const MOCK_HOST = process.env.MOCK_HOST || "127.0.0.1";
const MOCK_PORT = Number(process.env.MOCK_PORT || 0);
// Executor-facing mock URL (docker-network name), distinct from the host-published
// loopback the driver uses for control-plane calls. See registerInterpretationModel.
const MOCK_INTERNAL_URL = process.env.MOCK_INTERNAL_URL || `http://${MOCK_HOST}:${MOCK_PORT}/v1`;
const BASE_PREFIX = "wt://i1/";

async function main() {
  assertTrue(!!WS_PORT && !!MOCK_PORT, "the caller must set WS_PORT and MOCK_PORT");
  await waitForExecutorHealth(WS_HOST, WS_PORT);
  await waitForMockHealth(MOCK_HOST, MOCK_PORT);

  const client = new InterpClient(WS_HOST, WS_PORT, ADMIN);
  await client.connect();
  console.log("[i1] connected to executor");

  const modelId = await registerInterpretationModel(client, MOCK_INTERNAL_URL);
  console.log(`[i1] registered interpretation model ${modelId} against the mock, set as default LLM`);

  const persp = await client.createPerspective("i1-base");
  const uuid = persp.uuid;
  console.log(`[i1] perspective ${uuid}`);

  await registerModels(client, uuid, ["WtTask"]);
  console.log("[i1] registered WtTask (class hint + identity property 'title' + property 'owner', both with interpretation hints)");

  // Step 1: create. The canned reply deliberately wraps itself in a <think>
  // block and a ```json fence — real small models emit exactly this kind of
  // noise, and the executor's parser (`interpretation/parse.rs::clean_llm_json`)
  // must strip it before parsing (mirrors parse.rs's own `strips_code_fences` /
  // `strips_think_block` unit tests) for the instance to land at all.
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "create-onboarding-task",
      match: ["Priya", "onboarding guide"],
      response:
        '<think>This assigns Priya something concrete to do; that makes it a task.</think>\n' +
        '```json\n[{"class":"WtTask","title":"Write the onboarding guide","owner":"Priya"}]\n```',
    },
  ]);

  const transcript1 = [
    { speaker: "Sam", text: "Priya, can you write the onboarding guide for new hires this week?" },
    { speaker: "Priya", text: "Sure, I will get started today." },
  ];
  const bases1 = await client.runInterpretation(uuid, transcript1, BASE_PREFIX, ["WtTask"]);
  console.log(`[i1] runInterpretation #1 (create) -> ${JSON.stringify(bases1)}`);
  assertTrue(bases1.length === 1, `expected exactly one new instance, got ${bases1.length}: ${JSON.stringify(bases1)}`);
  const base = bases1[0];
  assertTrue(base.startsWith(BASE_PREFIX), `base ${base} must start with ${BASE_PREFIX}`);

  const typeLinks = await client.queryLinks(uuid, { source: base, predicate: WT_TASK_TYPE });
  assertTrue(
    typeLinks.length === 1 && typeLinks[0].data.target === WT_TASK_TYPE_VALUE,
    `instance ${base} must carry exactly one wt://type -> wt://task flag, got ${JSON.stringify(typeLinks)}`,
  );

  let rows = (await client.modelQuery(uuid, "WtTask", {})).instances;
  assertTrue(rows.length === 1, `expected exactly 1 WtTask instance after create, found ${rows.length}`);
  assertEqual(rows[0].title, "Write the onboarding guide", "created WtTask.title");
  assertEqual(rows[0].owner, "Priya", "created WtTask.owner");
  console.log("[i1] ok — typed WtTask instance created (type flag + title + owner), noisy mock reply parsed cleanly");

  // Step 2: re-run with a transcript that merely restates the SAME task, and a
  // mock reply that (deliberately) omits the `id` field — simulating a model
  // that forgot to attach it. The deterministic dedup safety net
  // (`filter_already_present` / `resolve_already_present_with_strategy` in
  // ad4m-interp's `interpretation/dedup.rs`) must still catch the duplicate by
  // identity value (title), independent of model behaviour.
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "restate-onboarding-task-no-id",
      match: ["reminder", "onboarding guide"],
      response: [{ class: "WtTask", title: "Write the onboarding guide", owner: "Priya" }],
    },
  ]);
  const transcript2 = [{ speaker: "Sam", text: "Just a reminder about the onboarding guide, Priya." }];
  const bases2 = await client.runInterpretation(uuid, transcript2, BASE_PREFIX, ["WtTask"]);
  console.log(`[i1] runInterpretation #2 (dedup re-run, no id in reply) -> ${JSON.stringify(bases2)}`);
  assertTrue(bases2.length === 0, `dedup re-run must not create/touch a new instance, got ${JSON.stringify(bases2)}`);

  rows = (await client.modelQuery(uuid, "WtTask", {})).instances;
  assertTrue(rows.length === 1, `dedup re-run must not duplicate; found ${rows.length} WtTask instance(s)`);
  assertEqual(rows[0].id, base, "the single surviving instance must match the original base");

  console.log(
    "[i1] PASS — subject class registered with interpretation hints; runInterpretation created a typed instance (readable back); re-run deduplicated with zero new instances",
  );
  client.close();
}

main().catch((e) => {
  console.error(`[i1] FAIL — ${e?.stack || e}`);
  process.exit(1);
});

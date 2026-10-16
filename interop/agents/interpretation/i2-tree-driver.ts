/**
 * I2 — tree-aware interpretation: after I1-equivalent state, a second
 * transcript must (a) update a known-id existing instance rather than
 * duplicate it, (b) route a proposal carrying an id the graph does not
 * recognise ("hallucinated") to a fresh Create instead of a silent no-op, and
 * (c) resolve a relation field against an EXISTING instance (not just a
 * sibling co-minted in the same pass) — the edge lands as a link.
 *
 * Mirrors `plan_interpretation_ops_resolved` in ad4m-interp's
 * `interpretation/graph/write.rs`: an id present in the `existing` snapshot
 * (built fresh on every call from the perspective's current instances) routes
 * to Update; any other id — including a fabricated one — falls outside
 * `existing`, so it routes to Create with a freshly minted base rather than
 * losing the proposal.
 *
 * Env: WS_HOST/WS_PORT (executor WS-RPC), ADMIN (token), MOCK_HOST/MOCK_PORT.
 */
import { InterpClient, registerInterpretationModel, waitForExecutorHealth, waitForMockHealth } from "./interp-client.js";
import { registerModels, WT_TASKLINK_PROJECT, WT_TASKLINK_TASK } from "./models.js";
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
const BASE_PREFIX = "wt://i2/";

function findByTitle(rows: any[], title: string): any {
  return rows.find((r) => r.title === title);
}

async function main() {
  assertTrue(!!WS_PORT && !!MOCK_PORT, "the caller must set WS_PORT and MOCK_PORT");
  await waitForExecutorHealth(WS_HOST, WS_PORT);
  await waitForMockHealth(MOCK_HOST, MOCK_PORT);

  const client = new InterpClient(WS_HOST, WS_PORT, ADMIN);
  await client.connect();
  console.log("[i2] connected to executor");

  const modelId = await registerInterpretationModel(client, MOCK_INTERNAL_URL);
  console.log(`[i2] registered interpretation model ${modelId}`);

  const persp = await client.createPerspective("i2-tree");
  const uuid = persp.uuid;
  console.log(`[i2] perspective ${uuid}`);

  await registerModels(client, uuid, ["WtTask", "WtProject", "WtTaskLink"]);
  console.log("[i2] registered WtTask, WtProject, WtTaskLink (relation edge: task -> project)");

  // ---- I1-equivalent state: a task, a project, and an edge co-minted in one
  // pass, linked via the `new:<Class>:<n>` sibling-ref syntax (prompt.rs's
  // `interpretation_examples()` ex4 teaches exactly this form). ----
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "create-task-project-link",
      match: ["Mei", "login bug", "Growth"],
      response: [
        { class: "WtTask", title: "Fix the login bug", owner: "Mei" },
        { class: "WtProject", name: "Growth" },
        { class: "WtTaskLink", task: "new:WtTask:1", project: "new:WtProject:1" },
      ],
    },
  ]);
  const transcript1 = [
    { speaker: "Mei", text: "I'll fix the login bug this week — filing it under the Growth project." },
  ];
  const bases1 = await client.runInterpretation(uuid, transcript1, BASE_PREFIX, ["WtTask", "WtProject", "WtTaskLink"]);
  console.log(`[i2] runInterpretation #1 (create task+project+link) -> ${JSON.stringify(bases1)}`);
  assertTrue(bases1.length === 3, `expected 3 new instances (task, project, link), got ${bases1.length}`);

  const taskRowsAfter1 = (await client.modelQuery(uuid, "WtTask", {})).instances;
  const task = findByTitle(taskRowsAfter1, "Fix the login bug");
  assertDefined(task, "the seeded WtTask must read back correctly");
  const taskBase: string = task.id;

  const projectRowsAfter1 = (await client.modelQuery(uuid, "WtProject", {})).instances;
  const project = projectRowsAfter1.find((r: any) => r.name === "Growth");
  assertDefined(project, "the seeded WtProject must read back correctly");
  const projectBase: string = project.id;

  const linkRowsAfter1 = (await client.modelQuery(uuid, "WtTaskLink", {})).instances;
  assertTrue(linkRowsAfter1.length === 1, `expected exactly 1 WtTaskLink after the seed pass, found ${linkRowsAfter1.length}`);
  const firstLinkBase: string = linkRowsAfter1[0].id;
  const firstLinkTask = await client.queryLinks(uuid, { source: firstLinkBase, predicate: WT_TASKLINK_TASK });
  const firstLinkProject = await client.queryLinks(uuid, { source: firstLinkBase, predicate: WT_TASKLINK_PROJECT });
  assertTrue(firstLinkTask[0]?.data.target === taskBase, "seed WtTaskLink.task must point at the co-minted WtTask");
  assertTrue(firstLinkProject[0]?.data.target === projectBase, "seed WtTaskLink.project must point at the co-minted WtProject");
  console.log(`[i2] ok — I1-equivalent state reached: task=${taskBase} project=${projectBase} link=${firstLinkBase}`);

  // ---- I2 main assertion: a second transcript that (a) updates the known
  // task by id, (b) proposes a hallucinated id for a brand-new task (must
  // Create, not vanish), and (c) links the new task to the EXISTING project
  // by its real id (not a `new:` sibling ref). ----
  const HALLUCINATED_ID = `${BASE_PREFIX}wttask/does-not-exist-0001`;
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "update-known-plus-hallucinated-create-plus-relation-to-existing",
      match: ["regression test", "release notes"],
      response: [
        // Ordinal WtTask:1 — a hallucinated id (not present in `existing`), so
        // this must route to Create with a fresh base, never a lost no-op.
        { class: "WtTask", id: HALLUCINATED_ID, title: "Write release notes for the fix", owner: "Zed" },
        // Ordinal WtTask:2 — the REAL existing task's id -> Update, not a dup.
        { class: "WtTask", id: taskBase, title: "Fix the login bug and add a regression test", owner: "Mei" },
        // Links the newly-minted task (sibling ref, ordinal 1) to the EXISTING
        // project (a real id from `existing`, not a `new:` ref) — tree growth.
        { class: "WtTaskLink", task: "new:WtTask:1", project: projectBase },
      ],
    },
  ]);
  const transcript2 = [
    { speaker: "Mei", text: "About the login bug — I'll also add a regression test for it." },
    { speaker: "Mei", text: "Separately, Zed should write the release notes for the fix, under Growth too." },
  ];
  const bases2 = await client.runInterpretation(uuid, transcript2, BASE_PREFIX, ["WtTask", "WtProject", "WtTaskLink"]);
  console.log(`[i2] runInterpretation #2 (update + hallucinated-id create + relation-to-existing) -> ${JSON.stringify(bases2)}`);

  // (a) The known task received an update in place, not a duplicate.
  const taskRowsAfter2 = (await client.modelQuery(uuid, "WtTask", {})).instances;
  const updatedTask = taskRowsAfter2.find((r: any) => r.id === taskBase);
  assertDefined(updatedTask, "the original task base must still exist");
  assertEqual(updatedTask.title, "Fix the login bug and add a regression test", "updated WtTask.title");
  assertEqual(updatedTask.owner, "Mei", "updated WtTask.owner");
  const loginBugTitled = taskRowsAfter2.filter((r: any) => r.title.startsWith("Fix the login bug"));
  assertTrue(loginBugTitled.length === 1, `known-id update must not duplicate; found ${loginBugTitled.length} matching rows`);

  // (b) The hallucinated-id proposal landed as a NEW instance under a fresh
  // base — never at the hallucinated id, and never silently dropped.
  const newTask = findByTitle(taskRowsAfter2, "Write release notes for the fix");
  assertDefined(newTask, "the hallucinated-id proposal must still land as a new WtTask");
  assertTrue(newTask.id !== HALLUCINATED_ID, "the new WtTask must NOT land at the hallucinated id");
  assertTrue(newTask.id.startsWith(BASE_PREFIX), `new WtTask base ${newTask.id} must come freshly minted under ${BASE_PREFIX}`);
  assertEqual(taskRowsAfter2.length, 2, "exactly 2 WtTask instances must exist now (original + new)");

  // (c) The new WtTaskLink resolves its `project` ref against the EXISTING
  // project (tree growth), and its `task` ref against the freshly minted task.
  const linkRowsAfter2 = (await client.modelQuery(uuid, "WtTaskLink", {})).instances;
  assertEqual(linkRowsAfter2.length, 2, "exactly 2 WtTaskLink instances must exist now (seed + new)");
  const newLink = linkRowsAfter2.find((r: any) => r.id !== firstLinkBase);
  assertDefined(newLink, "creating the second pass must produce a new WtTaskLink");
  const newLinkTask = await client.queryLinks(uuid, { source: newLink.id, predicate: WT_TASKLINK_TASK });
  const newLinkProject = await client.queryLinks(uuid, { source: newLink.id, predicate: WT_TASKLINK_PROJECT });
  assertTrue(newLinkTask[0]?.data.target === newTask.id, "new WtTaskLink.task must point at the freshly minted task");
  assertTrue(
    newLinkProject[0]?.data.target === projectBase,
    "new WtTaskLink.project must resolve to the EXISTING project's real id, proving relation-to-existing (tree growth)",
  );

  console.log(
    "[i2] PASS — known-id proposal updated in place (no duplicate); hallucinated-id proposal created a fresh instance; a relation/edge linked the new item to an EXISTING node",
  );
  client.close();
}

main().catch((e) => {
  console.error(`[i2] FAIL — ${e?.stack || e}`);
  process.exit(1);
});

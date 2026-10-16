/**
 * Hand-authored SHACL subject classes for the I-series scenarios.
 *
 * Normally an app declares these with `@Model`/`@Property`/`@HasOne` (see
 * ad4m-interp's `tests/js/tests/model/interpretation-models.ts` /
 * `auto-processor-models.ts`) and lets `Ad4mModel.register()` generate the
 * SHACL-JSON for `perspective.addSdna`. That decorator layer lives in
 * `@coasys/ad4m` (`core/`), which carries no build output in this environment —
 * so these classes take the wire format `addSdna`'s `shaclJson` param
 * expects (`rust-executor/src/perspectives/shacl_parser.rs`'s `SHACLShape` /
 * `PropertyShape`, snake_case, no camelCase rename), verified field-by-field
 * against that struct plus the hard-wired SDNA fixtures already shipped in
 * ad4m-interp (`rust-executor/src/perspectives/interpretation_test_support.rs`:
 * `TASK_SDNA`, `TASK_WITH_RELATION_SDNA`, `CONVERSATION_SUBGROUP_SDNA`, and the
 * engine's own `INTERP_RUN_SDNA` / `INTERP_OVERLAY_SDNA` /
 * `PROCESSING_CLAIM_SDNA` in `overlay/classes.rs` / `auto_processor/claim.rs`).
 *
 * Four classes, deliberately small and reused across all six scenarios:
 *   - WtTask     — identity-only dedup demo (I1, I3, I4).
 *   - WtProject  — a relation target (I2).
 *   - WtTaskLink — a relation *edge node* (I2) — mirrors the `SemanticRelationship`
 *                  few-shot example baked into the interpretation system prompt
 *                  (`prompt.rs`'s `interpretation_examples()`, ex4): a class whose
 *                  own fields carry forward relation refs to two other classes,
 *                  resolved via an existing `id` or a `new:<Class>:<n>` ordinal.
 *   - WtThread   — mirrors `ConversationSubgroup` exactly (identity `name` +
 *                  mutable `summary`) for the auto-processor scenarios (I5, I6).
 */

export interface ShaclAction {
  action: string;
  source: string;
  predicate: string;
  target: string;
  local?: boolean;
}

export interface ShaclProperty {
  path: string;
  name?: string;
  interpretation_hint?: string;
  identity?: boolean;
  min_count?: number;
  max_count?: number;
  resolve_language?: string;
  has_value?: string;
  setter?: ShaclAction[];
  relation_kind?: "hasMany" | "hasOne" | "belongsToOne" | "belongsToMany";
  target_class_name?: string;
  class?: string;
}

export interface ShaclShape {
  target_class: string;
  interpretation_hint?: string;
  constructor_actions: ShaclAction[];
  properties: ShaclProperty[];
}

// ── WtTask ──────────────────────────────────────────────────────────────────
export const WT_TASK_TYPE = "wt://type";
export const WT_TASK_TYPE_VALUE = "wt://task";
export const WT_TASK_TITLE = "wt://title";
export const WT_TASK_OWNER = "wt://owner";

export const WT_TASK_SHAPE: ShaclShape = {
  target_class: "wt://WtTask",
  interpretation_hint:
    "A concrete, actionable unit of work someone will do, ideally with an owner. Not a belief, a question, or a project.",
  constructor_actions: [{ action: "addLink", source: "this", predicate: WT_TASK_TYPE, target: WT_TASK_TYPE_VALUE }],
  properties: [
    { path: WT_TASK_TYPE, name: "type", has_value: WT_TASK_TYPE_VALUE, min_count: 1, max_count: 1 },
    {
      path: WT_TASK_TITLE,
      name: "title",
      identity: true,
      min_count: 1,
      max_count: 1,
      resolve_language: "literal",
      interpretation_hint: "Imperative summary of the task.",
      setter: [{ action: "setSingleTarget", source: "this", predicate: WT_TASK_TITLE, target: "value" }],
    },
    {
      path: WT_TASK_OWNER,
      name: "owner",
      min_count: 0,
      max_count: 1,
      resolve_language: "literal",
      interpretation_hint: "Person responsible for the task, if stated.",
      setter: [{ action: "setSingleTarget", source: "this", predicate: WT_TASK_OWNER, target: "value" }],
    },
  ],
};

// ── WtProject ───────────────────────────────────────────────────────────────
export const WT_PROJECT_TYPE = "wt://type";
export const WT_PROJECT_TYPE_VALUE = "wt://project";
export const WT_PROJECT_NAME = "wt://project_name";

export const WT_PROJECT_SHAPE: ShaclShape = {
  target_class: "wt://WtProject",
  interpretation_hint: "A named body of work or initiative that tasks can belong to.",
  constructor_actions: [{ action: "addLink", source: "this", predicate: WT_PROJECT_TYPE, target: WT_PROJECT_TYPE_VALUE }],
  properties: [
    { path: WT_PROJECT_TYPE, name: "type", has_value: WT_PROJECT_TYPE_VALUE, min_count: 1, max_count: 1 },
    {
      path: WT_PROJECT_NAME,
      name: "name",
      identity: true,
      min_count: 1,
      max_count: 1,
      resolve_language: "literal",
      interpretation_hint: "Short project name.",
      setter: [{ action: "setSingleTarget", source: "this", predicate: WT_PROJECT_NAME, target: "value" }],
    },
  ],
};

// ── WtTaskLink (edge node: task -> project) ─────────────────────────────────
export const WT_TASKLINK_TYPE = "wt://type";
export const WT_TASKLINK_TYPE_VALUE = "wt://tasklink";
export const WT_TASKLINK_TASK = "wt://link_task";
export const WT_TASKLINK_PROJECT = "wt://link_project";

export const WT_TASK_LINK_SHAPE: ShaclShape = {
  target_class: "wt://WtTaskLink",
  interpretation_hint:
    "An edge recording that a task belongs to a project. Only emit this when the transcript clearly assigns a task to a project.",
  constructor_actions: [{ action: "addLink", source: "this", predicate: WT_TASKLINK_TYPE, target: WT_TASKLINK_TYPE_VALUE }],
  properties: [
    { path: WT_TASKLINK_TYPE, name: "type", has_value: WT_TASKLINK_TYPE_VALUE, min_count: 1, max_count: 1 },
    {
      path: WT_TASKLINK_TASK,
      name: "task",
      relation_kind: "hasOne",
      target_class_name: "WtTask",
      class: "wt://WtTaskShape",
      interpretation_hint: "The task the assignment names.",
    },
    {
      path: WT_TASKLINK_PROJECT,
      name: "project",
      relation_kind: "hasOne",
      target_class_name: "WtProject",
      class: "wt://WtProjectShape",
      interpretation_hint: "The project the task belongs to.",
    },
  ],
};

// ── WtThread (mirrors ConversationSubgroup, for the auto-processor) ─────────
export const WT_THREAD_TYPE = "wt://type";
export const WT_THREAD_TYPE_VALUE = "wt://thread";
export const WT_THREAD_NAME = "wt://thread_name";
export const WT_THREAD_SUMMARY = "wt://summary";

export const WT_THREAD_SHAPE: ShaclShape = {
  target_class: "wt://WtThread",
  interpretation_hint:
    "A coherent conversational thread - a set of turns focused on the same topic. Group turns discussing the same subject under one thread; a clear shift in subject starts a new thread. When an existing thread already covers the topic under discussion, REUSE its id (via the `id` field on the proposed instance) instead of creating a duplicate. Only reuse an existing thread's id when the current turns clearly match the SAME topic as that thread's name.",
  constructor_actions: [{ action: "addLink", source: "this", predicate: WT_THREAD_TYPE, target: WT_THREAD_TYPE_VALUE }],
  properties: [
    { path: WT_THREAD_TYPE, name: "type", has_value: WT_THREAD_TYPE_VALUE, min_count: 1, max_count: 1 },
    {
      path: WT_THREAD_NAME,
      name: "name",
      identity: true,
      min_count: 1,
      max_count: 1,
      resolve_language: "literal",
      interpretation_hint: "Short label for the topic (2-5 words).",
      setter: [{ action: "setSingleTarget", source: "this", predicate: WT_THREAD_NAME, target: "value" }],
    },
    {
      path: WT_THREAD_SUMMARY,
      name: "summary",
      min_count: 0,
      max_count: 1,
      resolve_language: "literal",
      interpretation_hint: "1-2 sentence rolling summary of what this thread has covered specifically.",
      setter: [{ action: "setSingleTarget", source: "this", predicate: WT_THREAD_SUMMARY, target: "value" }],
    },
  ],
};

export const ALL_WT_SHAPES: Record<string, ShaclShape> = {
  WtTask: WT_TASK_SHAPE,
  WtProject: WT_PROJECT_SHAPE,
  WtTaskLink: WT_TASK_LINK_SHAPE,
  WtThread: WT_THREAD_SHAPE,
};

/** Interpretation-class URI a given local name resolves to — what `classes`
 * on `runInterpretation`/`interpretationClasses` on `addAutoProcessor` expects
 * (the shape's own `target_class`, matching `ns://ConversationSubgroup`-style
 * usage in `auto-processor.test.ts`). */
export function classUri(localName: keyof typeof ALL_WT_SHAPES): string {
  return ALL_WT_SHAPES[localName].target_class;
}

/** Registers one or more of the classes above on a perspective via
 * `perspective.addSdna` (client accepts any object exposing `addSdna` — typed
 * loosely so both `InterpClient` instances work without a circular import). */
export async function registerModels(
  client: { addSdna: (uuid: string, name: string, shaclJson: string) => Promise<boolean> },
  uuid: string,
  names: (keyof typeof ALL_WT_SHAPES)[],
): Promise<void> {
  for (const name of names) {
    const shape = ALL_WT_SHAPES[name];
    await client.addSdna(uuid, name, JSON.stringify(shape));
  }
}

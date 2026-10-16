# I-series — Generic-LLM-Interpretation Wind Tunnel

Six scenarios exercise AD4M's generic-LLM-interpretation feature end to end
against a real, containerised executor: base extraction + dedup, tree-aware
upsert + relations, the provenance overlay + human-divergence gate, human
accept/reject of staged suggestions, and the neighbourhood auto-processor
(single- and two-executor). A deterministic mock stands in for the LLM, so
every result reproduces exactly, and every non-model failure traces back to the
executor, never to model variance.

The feature under test lives in `ad4m-interp` (PR [#881](https://github.com/coasys/ad4m/pull/881)):
the base engine, tree-aware upsert, the provenance overlay + human-divergence
gate, the neighbourhood auto-processor, and the WS API + TS client this harness
drives directly.

## Why WS-RPC, not MCP or `@coasys/ad4m`

`runInterpretation` / `addAutoProcessor` / `interpretationOverlays` /
`acceptInterpretation` / `rejectInterpretation` carry **no MCP tool** — they
exist only on `PerspectiveProxy`, itself a thin wrapper over the executor's raw
WebSocket-RPC protocol (`ws://host:port/api/v1/ws?token=<admin-or-user-jwt>`,
JSON `{id,type,params}` request / `{id,result}` response — the same wire format
`interop/README.md`'s language-interop scripts and this repo's own
`src/client.ts` already speak). The `@coasys/ad4m` TypeScript package that
normally wraps this wire protocol (`core/`) has no build output in the #881
worktree in this environment, and building it stayed out of scope for this
pass — so `interop/agents/interpretation/interp-client.ts` speaks the wire
protocol directly. Every method it exposes carries a cross-check against
`core/src/perspectives/PerspectiveClient.ts` / `PerspectiveProxy.ts` and the
Rust WS handlers in `rust-executor/src/api/perspectives_ws.rs`, so it should
call-compatible with the real client once someone builds one — swapping this
file for a real `@coasys/ad4m` import makes a natural follow-up once `core`
gets a build.

Subject classes (`WtTask`, `WtProject`, `WtTaskLink`, `WtThread`, in
`interop/agents/interpretation/models.ts`) likewise use hand-authored
SHACL-JSON rather than the `@Model`/`@Property` decorators (which also live in
the unbuilt `core` package) — verified field-by-field against the Rust
`SHACLShape` / `PropertyShape` structs (`rust-executor/src/perspectives/shacl_parser.rs`)
and the hard-wired SDNA fixtures already shipped in ad4m-interp
(`interpretation_test_support.rs`'s `TASK_SDNA`, `TASK_WITH_RELATION_SDNA`,
`CONVERSATION_SUBGROUP_SDNA`; the engine's own `INTERP_RUN_SDNA` /
`INTERP_OVERLAY_SDNA` / `PROCESSING_CLAIM_SDNA`).

## The mock's interpretation mode

`interop/agents/mock-llm/server.mjs` already speaks OpenAI chat-completions +
Anthropic Messages for the A-series (scripted tool-call steps). Generic-LLM-
interpretation calls take a different shape entirely: a plain completion
carrying **no `tools` array**, whose only user turn holds the JSON
`{"classes":[...],"transcript":[...]}` payload `build_interpretation_input`
assembles (`ad4m-interp/rust-executor/src/perspectives/interpretation/prompt.rs`).
The mock recognises that shape and answers from a **content-keyed rule table**
instead of the scripted step sequence, so interpretation calls never consume or
interfere with an A-series `MOCK_LLM_SCRIPT` step:

```
MOCK_LLM_INTERP_RULES = [
  { "label"?: string, "match": string | string[], "response": any }
]
```

Every `match` substring must appear in the raw request body (an AND over the
array form — the transcript text sits inside a JSON-escaped string, so plain
unquoted marker words match reliably). The first matching rule's `response`
becomes the assistant's plain-text reply — either a JSON value
(auto-`JSON.stringify`d into the exact array shape `interpretation/parse.rs`
expects: `[{"class": "...", ...fields, ...relations}, ...]`) or a raw string
sent verbatim (I1 uses this to wrap a reply in a `<think>` block and a
` ```json ` fence, proving the executor's noise-stripping parser handles it end
to end — mirrors `parse.rs`'s own `strips_code_fences` / `strips_think_block`
unit tests). When no rule matches, the mock returns `"[]"`, a valid empty
extraction — never the tool-script's `"ok"` filler, which fails to parse as
interpretation JSON and would burn the executor's 5-attempt retry budget
(`INTERPRETATION_MAX_ATTEMPTS`) on every unmatched call.

Rules can load at container start (`MOCK_LLM_INTERP_RULES` env var) or push at
runtime:

```
POST /interp-rules   { "rules": [...] }   -> replaces the table, {ok:true,count}
GET  /interp-rules                        -> current table (debugging)
```

Runtime pushes matter because a follow-up call's canned reply often needs to
reference a base URI the executor mints only after the first call returns
(e.g. I2/I3/I4 attach a real `id` to an Update proposal) — see
`interop/agents/interpretation/mock-control.ts`'s `setInterpRules`.

This design stays fully additive: the mock recognises an interpretation-shaped
request only when the call carries no `tools` array, so every existing/future
A-series scripted-tool-call flow continues to work unchanged.

## Model registration

`interop/agents/interpretation/interp-client.ts`'s `registerInterpretationModel`
does exactly what `run-interpretation.test.ts` / `auto-processor.test.ts` do:

```
ai.addModel({ name, api: { baseUrl: "<mock>/v1", apiKey, model, apiType: "OPEN_AI" }, type: "LLM" })
ai.setDefaultModel({ id: <modelId>, modelType: "LLM" })
```

`ensure_interpretation_task`'s DB row binds to model_id `"default"`, which
`AIService::replace_model_variables` resolves to whichever model holds the
default-LLM slot (`rust-executor/src/ai_service/mod.rs`) — so setting the
default suffices; no per-task model wiring matters. An `add_model` MCP tool
(`mcp__ad4m__add_model`) also reaches the same `ai.addModel` RPC, but since
every I-series driver already holds a live WS connection for everything else,
the direct RPC call stays simpler and avoids standing up MCP plus a second auth
path for no benefit.

## Scenarios

| ID | Script | Asserts |
|----|--------|---------|
| **I1** | `verify-i1-base.sh` | A subject class carrying a class-level + per-property interpretation hint and one identity property; `runInterpretation` creates a typed instance (type flag + fields, readable back); a noisy mock reply (`<think>` + code fence) parses cleanly; a re-run that restates the same task (no `id` attached) deduplicates via the identity-value safety net — zero new instances. |
| **I2** | `verify-i2-tree.sh` | After reaching I1-equivalent state (task + project + a `WtTaskLink` edge co-minted via `new:<Class>:<n>`): a known-id proposal updates in place (no duplicate); a proposal carrying an id the graph does not recognise ("hallucinated") routes to a fresh Create instead of a silent no-op; a relation field resolves against an EXISTING instance (not just a co-minted sibling) — the edge lands as a real link. |
| **I3** | `verify-i3-provenance.sh` | A create pass yields real==inferred plus an overlay (`kind:"create"`, `run` under `ad4m://interp/run/`). A human edits one property directly. A divergent re-run leaves the human's value untouched (only an overlay-only suggestion gets staged) while a still-LLM-owned field in the SAME call updates normally. Confirms the overlay's `kind` stays `"create"` across passes — an easy detail to get backwards. |
| **I4** | `verify-i4-accept-reject.sh` | Three independent bases cover all four corners of `overlay/accept.rs`: property-scoped accept materializes a staged suggestion onto the real value (explicitly overwriting a prior human edit); whole-base accept on an already-resolved remainder just drops the overlay shell; whole-base reject on an untouched create overlay deletes the ENTIRE instance; property-scoped reject on a diverged update drops the suggestion and keeps the human's real value. |
| **I5** | `verify-i5-autoprocessor.sh` | `addAutoProcessor` on a channel-shaped scope query; a 2-message burst from two distinct authors triggers the executor's OWN watch loop (not a manual `runInterpretation`) — debounce, claim, run the LLM, write — exactly once; a grace period afterwards confirms no double-processing / no duplicate instance. |
| **I6** | `verify-i6-autoprocessor-2exec.sh` | Two independent executors each correctly run the I5 assertion on their own local channel (always runs, proves the mechanism stays topology-agnostic). The REAL cross-executor min-DID `ProcessingClaim` race needs a synced neighbourhood (Holochain-backed `perspective-diff-sync`) this harness cannot stand up blind — see below. |

## I6's honest partial

The full two-executor claim assertion — two peers racing to process the SAME
*synced* batch, exactly one winning by the lexicographically-smallest DID
(`rust-executor/src/perspectives/auto_processor/claim.rs`) — only means anything
once both executors' `ProcessingClaim` links have actually converged, which
needs a real neighbourhood: a published `perspective-diff-sync` language
template, applied on one executor and joined from the other, over Holochain.

Two gaps block this, and neither resolves without running code against the
real image:

1. **No local `perspective-diff-sync` language artifact.** ad4m-interp's own
   two-executor JS test (`tests/js/tests/auto-processor-neighbourhood.ts`) reads
   its language content-hash from `./scripts/perspective-diff-sync-hash`, a file
   the JS test suite's own `pnpm run prepare-test` step produces — absent from
   the repo, and out of reach without running that build.
2. **Unverified `RUN_HOLOCHAIN` support in the I-series image.** Every existing
   A-series scenario in this harness runs with Holochain OFF. The #881
   worktree's `docker-entrypoint.sh` (checked at the time of writing) never
   references `RUN_HOLOCHAIN`, so whether the interpretation executor image even
   exposes a Holochain toggle — or what it might get called — remains unknown.

`i6-autoprocessor-2exec-driver.ts` implements the real join anyway
(`applyTemplateAndPublish` + `publishNeighbourhood` + `joinFromUrl`, mirroring
`auto-processor-neighbourhood.ts`'s own flow) behind two env vars that default
unset — `I6_ATTEMPT_NEIGHBOURHOOD=1` and `I6_DIFFSYNC_LANGUAGE_HASH=<hash>` (plus
`I6_RUN_HOLOCHAIN=true` on the verify script, since the executor containers
default to `RUN_HOLOCHAIN=false` like every other I-series scenario). With
neither set — the default — the script prints a clear `SKIP` for the
cross-executor claim assertion specifically and still passes overall, on the
strength of the two independently-verified single-executor passes. Once a
`perspective-diff-sync` hash becomes available and someone confirms the image's
Holochain toggle, set the three env vars to exercise the real race.

## Running

```bash
# Each script stands alone: brings up its own executor(s) + mock, tears down on
# exit. KEEP=1 leaves the pod up for debugging.
./verify-i1-base.sh
./verify-i2-tree.sh
./verify-i3-provenance.sh
./verify-i4-accept-reject.sh
./verify-i5-autoprocessor.sh
./verify-i6-autoprocessor-2exec.sh
```

| Variable | Default | Description |
|---|---|---|
| `INTERP_EXEC_IMAGE` | `ad4m-test-interp:latest` | The interpretation-capable executor image. Every script SKIPs honestly (exit 0) when this image stays absent. |
| `KEEP` | unset | `1` leaves the pod(s) up after a run for debugging. |
| `I6_ATTEMPT_NEIGHBOURHOOD` | unset | I6 only — `1` opts into the real two-executor neighbourhood join. |
| `I6_DIFFSYNC_LANGUAGE_HASH` | unset | I6 only — content hash of a published `perspective-diff-sync` language template, required alongside the flag above. |
| `I6_RUN_HOLOCHAIN` | `false` | I6 only — passed as `RUN_HOLOCHAIN` to both executor containers. |

Executors run **single-agent** (no `ENABLE_MULTI_USER`/`ENABLE_MCP`) and
admin-credential secured — every I-series operation (model registration,
subject-class registration, interpretation runs, human edits, accept/reject)
rides the one admin-credentialed WS connection, matching how
`run-interpretation.test.ts` / `auto-processor.test.ts` drive a single agent.
`--memory 4g` (not the A-series' 2g default) — the 2g default OOMs the
executor, a finding already carried into the A-series scripts.

## Assumptions needing runtime verification

Everything below came from reading ad4m-interp's Rust/TS source directly
(prompt.rs, parse.rs, the overlay/claim modules, the WS handlers, the SHACL
structs) rather than from running it, because the executor image kept building
elsewhere while this took shape. Flagged here for the first real run against
`ad4m-test-interp:latest`:

- **Wire format kalosm speaks.** The executor's remote-LLM client
  (`AIService::build_remote_client`, backed by the `kalosm` crate) should speak
  plain OpenAI chat-completions (`POST {baseUrl}/chat/completions`) — inferred
  from `ModelApiType::OpenAi` standing as the only variant, `baseUrl` already
  including `/v1` in every ad4m-interp fixture, and the A-series mock already
  serving exactly this shape. Not directly confirmed against kalosm's own
  source (a vendored git dependency absent from this environment).
- **Executor readiness timing.** `docker-entrypoint.sh`'s `wait_for_executor()`
  (`curl -sf http://localhost:12000/`) runs before `maybe_setup_agent()`
  (agent generate/unlock) — so `waitForExecutorHealth` adds an 8s grace margin
  after the HTTP probe first succeeds. Untested against the real image; may
  need lengthening.
- **Single-agent mode suffices.** This assumes no `ENABLE_MULTI_USER`/
  `ENABLE_MCP` matters for any I-series operation (interpretation writes gate on
  capability checks that an admin credential bypasses,
  `get_perspective_with_access` in `perspectives_ws.rs`). If the I-series image
  needs multi-user mode for some other reason, the scripts need
  `ENABLE_MULTI_USER=true` plus a provisioned user JWT added back in.
- **`RUN_HOLOCHAIN` support.** Unverified for this image — see I6's section
  above.
- **Relation ordinal semantics in I2's canned reply** (`new:WtTask:1` etc.) —
  derived from reading `plan_interpretation_ops_resolved`
  (`interpretation/graph/write.rs`) directly: ordinals count every placed
  proposal of a class in output order, including ones that route to Update, not
  only Creates. Double-checked against the source but never executed.
- **`modelQuery` relation-field hydration** — I2/I5's assertions deliberately
  read relation edges via raw `queryLinks` (a relation's target holds the
  related instance's plain base URI) rather than via `modelQuery`'s
  relation-field output, avoiding any dependency on an unconfirmed hydration
  shape for `hasOne`/`hasMany` fields.

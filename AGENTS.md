# AGENTS.md — AD4M Wind Tunnel

Persistent operational notes for anyone (human or agent) working in this repo.
Keep this current: if you discover a new gotcha or change the harness, record it
here in the same task.

## What this repo is

Three test surfaces for the [AD4M](https://ad4m.dev) executor and its link
languages:

1. **Wind Tunnel** (`src/`) — performance/load scenarios that drive one or more
   real executors over WS-RPC and record latency/throughput/RSS. Entry point
   `src/main.ts`, orchestrated by `run.sh`.
2. **Interop** (`interop/`) — shell scripts that prove a single language
   reads/writes its native backend (Docker-hosted).
3. **Convergence** (`src/scenarios/c1-convergence.ts` + `src/convergence/`) —
   the multi-agent gap-closer: installs a link language into **two** executors
   over its live backend and asserts cross-agent link-set convergence. This is
   the only scenario that proves real perspective-sync, not a per-executor
   baseline.

## Build & run

```bash
npm install

# Full run (builds the executor from source — slow):
./run.sh --branch <branch>

# Fast: reuse a pre-built executor binary:
./run.sh --skip-build --executor-path /path/to/ad4m-executor --scenario <id>

# Compare two branches:
./run.sh --branch main --branch <feature>
```

`run.sh` just calls `npx tsx src/main.ts "$@"`. Results land in
`results/<branch>/` (slashes → dashes); `npx tsx src/report.ts` regenerates
`results/comparison.md`.

Key flags/env (CLI wins over env): `--admin-token` / `AD4M_ADMIN_TOKEN`
(default `test123`), `--base-port` / `AD4M_WT_BASE_PORT` (default `12100`),
`--tmp-dir` / `AD4M_WT_TMPDIR`, `--ad4m-repo` / `AD4M_REPO` (needed only when
building). See README for the full table.

## Architecture

```
src/
├── main.ts             # Runner: parses flags, boots one executor per scenario
├── client.ts           # InstrumentedClient — WS-RPC wrapper with timing
├── executor.ts         # Executor lifecycle: build / start / waitForHealth / stop
├── scenario.ts         # Scenario + ScenarioContext + ScenarioResult interfaces
├── convergence/
│   └── languages.ts     # Registry of convergence languages (bundle path, backend, template params)
├── w1/                  # W1 helpers: we-app (build/serve WE), auth (JWT + connect storage),
│                        #   seed (UI space + WE-package content), ws-recorder (CDP), analyze, proc-stats
└── scenarios/
    ├── index.ts         # Scenario registry — every scenario must be registered here
    ├── c1-convergence.ts# Multi-agent convergence (see below)
    └── ...              # perf/leak/mesh/sfu scenarios
```

The runner boots a **fresh executor per scenario** on `--base-port` (default
12100). Scenarios that need a second executor (m1, c1) start it themselves on
`port + 1` using `ctx.executorPath`. Executors run with
`--hc-use-bootstrap false --hc-use-proxy false` and admin token from ctx.

## C1 convergence — how it works

`ScenarioContext` carries `executorPath`, `adminToken`, `adamRepoPath`,
`tmpDirBase`, `port`, `branch`, `client`. C1:

1. Probes the language's `backend.healthTcp` and **skips honestly** if the
   backend is down — it never fakes a pass.
2. Starts executor **B** on `port + 1`, waits for health.
3. Agent A: `publishLanguage(bundlePath)` → `applyTemplateAndPublish(templateData)`
   → `createPerspective` → `publishNeighbourhood`.
4. Agent B: `neighbourhood.join(url)` — installs the **same templated language**,
   fetched from the language-language store by content address.
5. Both agents write `C1_LINKS` (default 10) links each, interleaved.
6. Poll both agents' `queryLinks` until each is a superset of every expected key,
   or `C1_TIMEOUT_MS` (default 60000) elapses. Convergence proof = link-set
   equality (currentRevision is not on the WS-RPC wire).
7. If add-convergence succeeds, propagate one removal and check tombstone
   convergence (best-effort, non-fatal).

Run it:

```bash
# 1. Bring the backend up (nostr shown; see infra/ for others):
sg docker -c "docker compose -f infra/docker-compose.nostr.yml up -d"

# 2. Rebuild the language bundle if you changed the language source:
( cd ../nostr-link-language && deno run --allow-all esbuild.ts )

# 3. Run C1 against that language:
npx tsx src/main.ts --scenario c1 --branch convergence \
  --skip-build --executor-path /path/to/ad4m-executor
# language selection: --convergence-language <id>  or  CONVERGENCE_LANGUAGE=<id>
# link count: C1_LINKS=<n>   timeout: C1_TIMEOUT_MS=<ms>
```

### Registering a convergence language

Add an entry to `src/convergence/languages.ts`: `id`, `bundlePath` (the built
JS bundle the executor installs), `possibleTemplateParams`,
`makeTemplateData(neighbourhoodId)`, and optional `backend { compose, healthTcp }`.
The scenario reads everything else from there.

### link-server lives inside the ad4m monorepo

Unlike every other convergence language (sibling repos next to the wind
tunnel), `server-link-language` lives at
`ad4m/bootstrap-languages/server-link-language/`. Its Docker compose
(`infra/docker-compose.link-server.yml`) builds from `../../ad4m/link-server`.
The link-server requires `AUTO_ADMIT=true` for C1 — without it, Agent B cannot
join the room Agent A created. Backend health probes TCP on port 3456.

### IPFS is the two-node backend (operational note)

Unlike every other C1 backend (one shared server the co-located agents both
hit), IPFS runs **two genuinely separate Kubo nodes** — `infra/docker-compose.ipfs.yml`
brings up node A (`:5001`) and node B (`:5002`), swarm-peered with distinct
blockstores — behind ONE **pubsub-bridge sidecar** (`ipfs-link-language/gateway`,
`npm start` on `:7793`). The sidecar's `healthTcp` (`:7793`) is the single
readiness gate: it can only be up once both nodes are up and peered. The sidecar
routes each agent's DID to its own node (`X-Ad4m-Did`), so the same templated
bundle drives both nodes. Bring-up order: two Kubo nodes → peer them → start the
sidecar → run C1. Convergence rides **pubsub inline-diffs, not bitswap** (bitswap
does not cross-node on Kubo 0.42.0). The four transport defects this run surfaced
(merge-not-inlined, Node keepAliveTimeout race, Deno `allow_env:none`, bounded
`dag/get`) live in the [ipfs-link-language](https://github.com/coasys/ipfs-link-language)
`AGENTS.md` and CAPABILITIES.md.

## W1 — WE space RPC footprint

`src/scenarios/w1-we-space-rpc.ts` drives the real WE web app (headless Chromium via
`playwright-core`) against the runner's executor and records every executor WebSocket frame from
CDP. It is the only scenario that measures a client app rather than the executor API directly.
README → "W1" has the flow, env knobs and output files. Run:

```bash
AD4M_REPO=<ad4m checkout> WE_REPO=<we checkout> ./run.sh --skip-build \
  --executor-path <ad4m checkout>/target/release/ad4m-executor --scenario w1 --branch w1-run1
```

Load-bearing details:

- **Executor runs with `--enable-multi-user false`** (`Scenario.multiUser = false`; the runner passes
  it to `startExecutor`). Every other scenario still gets `true`.
- **Auth shortcut.** ad4m-connect keeps its session in localStorage under its *package version*
  prefix: `<version>/ad4m-token`, `<version>/ad4m-url`, `<version>/ad4m-port` (ad4m
  `connect/src/utils.ts` `setLocal`; read in `connect/src/core.ts` constructor). The version is read
  from whichever connect package the build used. The token is a real JWT minted with WE's app info
  (`src/w1/auth.ts`), not the admin credential.
- **SDK.** WE pins `@coasys/ad4m` by commit (root `package.json` overrides). `W1_SDK=executor`
  (default) aliases the SDK to the executor's ad4m checkout through a generated wrapper Vite config
  in `<tmp>/ad4m-wt-w1-we/` that imports WE's own `apps/we-web/vite.config.ts`; nothing in the WE tree
  changes. The ad4m checkout needs `core/lib` and `connect/dist` built.
- **WE needs `pnpm build:web` first, with `NODE_ENV` unset** (the shell's `NODE_ENV=production`
  breaks WE builds and also makes `npm install` here skip devDependencies).
- **Shared spaces** need WE with coasys/we#349 against an executor with coasys/ad4m#1466
  (`runtime.linkLanguageTemplates` returns `LanguageMeta[]`); older WE fails `createSpace` with
  `Invalid params for language.applyTemplate: invalid type: map, expected a string`.
- **Real message writes are slow; most messages are pooled.** `createBlocks` uploads each message's
  editor state with `expression.create` on the holochain file-storage language (two zome calls,
  serialised per language: ~1.4 s a message, ~10 min for 420). At 16 in flight they also pass the
  SDK's 30 s call timeout. So only `W1_DISTINCT_BODIES` (24) messages go through `createBlocks`; the
  rest copy one of those bodies through the same model calls in batches of `W1_SEED_BATCH`, with the
  `we://editor_state` link pointing at an already-uploaded file (`setProperty` always re-uploads, so
  the link is written directly). The first copy of each kind is compared predicate-for-predicate
  with its exemplar; channel containment and `we://response`/`we://thread`/`we://signal` counts are
  verified at the end. Default sizes seed in ~2 min. Copies share bodies, so text repeats every 24.
- **Reading message rows is slow on the executor, by design of the current code.**
  `model_query/query.rs` `resolve_language_transforms` fetches every expression-resolved property of
  every row (a file-storage read for `editorState`, ~350 ms) whatever `properties` the query
  selects. W1 surfaces it as WE's container-activity query timing out (30 s) on open.
- **Discord template + AD4M ids:** a channel route is `/channel/<id>` and AD4M ids are
  `ad4m://obj/…`, which `RouteStore.templateSegments` splits on `/`; the channel view shows "No such
  channel". W1's Discord steps still run (rail clicks, read markers) but no message list renders.
- **The neighbourhood URL arrives after the create modal closes**; the scenario polls
  `perspective.all` for `sharedUrl`.
- **`page.evaluate` with a function breaks under tsx** (`__name is not defined`: esbuild's keepNames
  helper is not in the page). Pass a string expression, or keep functions free of named inner
  functions/consts.
- The create-space Personal/Shared switch's labels intercept the pointer; click the
  `role=switch` with `force` and retry until "Shareable space" shows.

## Known gotchas (load-bearing — read before debugging convergence)

These are the three real bugs the convergence harness surfaced. Each one
silently produced "both executors sit at their own local link count and never
converge", and each was invisible to the languages' own unit tests because a
mock transport does not enforce relay/runtime semantics.

1. **strfry ships a placeholder whitelist write-policy.** The `dockurr/strfry`
   image wires `/app/write-policy.py` (a pubkey/IP whitelist stub with
   placeholder values like `hex-pubkey-1`, `1.1.1.1`) at `/etc/strfry.conf`.
   It **rejects every real event** (`blocked: pubkey … not in whitelist`).
   `infra/strfry-accept-all.py` overrides it (mounted read-only over
   `/app/write-policy.py` in `docker-compose.nostr.yml`) to accept any
   well-formed event on this localhost test relay. strfry also needs a high
   `nofile` ulimit — set in the compose file. If events aren't landing, scan
   the relay DB directly: `sg docker -c "docker exec ad4m-test-nostr-relay
   strfry scan --count '{\"kinds\":[9078]}'"`.

2. **NIP-01 relays only index single-letter tag names.** A REQ subscription
   whose filter keys on a multi-character tag (e.g. `#ad4m:neighbourhood`) is
   **rejected** by spec-compliant relays (strfry: `unindexed tag filter`) and
   delivers zero events. Every event that must be relay-filterable therefore
   needs a **single-letter** scope tag (the languages use `d`), and the REQ
   filter must key on `#d`. A language can pass all its unit tests (mock
   transport ignores the rule) yet never receive a single inbound event on a
   real relay.

3. **The executor DISCARDS a link language's `sync()` return value.**
   `rust-executor/src/languages/language.rs` runs
   `await language.perspectiveSyncSync()` purely for side effects. Inbound
   links a language folds during `sync()` become queryable on the perspective
   **only** if the language pushes them through the `emitPerspectiveDiff` host
   channel (or the legacy `linkSyncAddCallback`). A language whose `sync()`
   folds correctly but only *returns* the delta will converge in its own
   internal store while `perspective.queryLinks` shows nothing — the C1 poll
   times out at `A=local, B=local`.

When C1 reports "DID NOT CONVERGE", walk these three in order before suspecting
the harness: (a) are events in the relay DB? (b) does the REQ filter use a
single-letter key? (c) does the language emit inbound folds, not just return
them?

## Conventions

- Every new scenario must be registered in `src/scenarios/index.ts`.
- Scenarios must skip honestly (record `skipped: true`) when a dependency is
  unreachable — never fabricate a pass.
- Executor flags are chosen at spawn time in the runner/scenario, not read from
  the scenario object after boot.

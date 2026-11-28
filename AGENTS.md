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
├── scenarios/
│   ├── index.ts         # Scenario registry — every scenario must be registered here
│   ├── c1-convergence.ts# Multi-agent convergence (see below)
│   ├── u1-we-call-transcription.ts # WE session RPC report (see below)
│   └── ...              # perf/leak scenarios
└── we/                  # U1 support: env, WE dev server, UI driver, devtools capture, analysis, report
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

## U1 — WE session RPC report

U1 (`--scenario u1`, opt-in: `main.ts` keeps it out of the default run) drives WE's web app in Chrome
against the runner's executor and reports WE's executor traffic. Layout of `src/we/`:

| File | Role |
|------|------|
| `env.ts` | Finds WE (`WE_REPO`), ad4m-devtools (`AD4M_DEVTOOLS`), the speech clip, ffmpeg, Chrome; lists what is missing |
| `setup.ts` | Operator steps over WS-RPC: install Whisper, create the user WE runs as |
| `we-server.ts` | Vite dev server for `apps/we-web` on `port + 50` |
| `ui.ts` | Playwright steps, selecting by what WE puts in the DOM (text, `aria-label`, `we-icon[name]`, reflected `variant`) |
| `devtools.ts` | Session + bridge injection, the bridge tap, wire and HTTP capture |
| `callsites.ts` | Maps stack frames to WE source lines through source maps |
| `rpc-analysis.ts` | Pure analysis; unit-tested in `rpc-analysis.test.ts` (`npm test`) |
| `rpc-report.ts` | Markdown report |

Gotchas, each found the hard way:

- **Do not read requests back from the bridge's store.** It is a 2,000-entry ring shared with push
  events, and creating a space alone pushes ~13,000 `link-added` events — requests fall out of the
  ring between polls. `TAP_SCRIPT` wraps the bridge's `logOperation` / `completeOperation` /
  `patchOperation` instead (its WebSocket monitor logs through the object it exposes as
  `window.__AD4M_DEVTOOLS__`). Push events are counted from Playwright's frames, not the bridge.
  Capture integrity = bridge request count equals wire request count; U1 fails otherwise.
- **The bridge's caller stack is unreliable under concurrency.** It stashes a stack when an SDK method
  is entered and pairs it with the next send in FIFO order, so parallel calls get each other's stacks.
  U1 keeps only the part after `--- async ws.send ---`, which is V8's own async chain at send time.
- **The bridge makes its own calls.** Once it finds `<ad4m-connect>` it calls `perspective.all()`
  (up to 16 times, 2 s apart) to patch prototypes. U1 names the injected script
  `ad4m-devtools-bridge.js` (`//# sourceURL`) and excludes any request whose outermost frame is in it.
- **WE UI:** the sidebar rail opens on hover — "Add a space" (`aria-label`) exists only while it is
  open. A new space is not opened for you. The template picker is the right rail's
  `we-icon[name="layout"]` button. The call bar's record toggle is `we-icon[name="text-aa"]`; its
  `variant` is `danger` while transcribing. WE starts transcription by itself on joining a call when a
  model is installed — pressing the toggle then would turn it off.
- **`ai.addModel` takes `type`, not `modelType`** (the SDK renames it), and answers only after the
  weights download — poll `ai.models` and `ai.modelLoadingStatus` instead of awaiting it.
- **Pad the speech clip with silence.** WE's worklet closes an utterance on a pause; a clip looped back
  to back is one utterance that never ends.
- **`NODE_ENV=production` in the shell** puts Vite's dev server in production mode and makes pnpm skip
  devDependencies. U1 strips it for the processes it starts.

## Conventions

- Every new scenario must be registered in `src/scenarios/index.ts`.
- Scenarios must skip honestly (record `skipped: true`) when a dependency is
  unreachable — never fabricate a pass.
- Executor flags are chosen at spawn time in the runner/scenario, not read from
  the scenario object after boot.

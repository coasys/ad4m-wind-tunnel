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
building), `--run-holochain <bool>` / `AD4M_WT_RUN_HOLOCHAIN` (default true,
always passed to the executor explicitly), `--repeat <n>` / `AD4M_WT_REPEAT`,
`--link-server-url` / `LINK_SERVER_URL`. `AD4M_WT_EXECUTOR_LOG_DIR` keeps
executor stdout/stderr. See README for the full table.

`npm test` runs the harness unit tests (`src/**/*.test.ts`); `npx tsc --noEmit`
must stay at zero errors.

## Platform baseline (P1–P5)

What one hosted executor costs: idle (`p1`), per space (`p2-perspectives`,
`p2-neighbourhoods`), cold open (`p3`), after removal (`p4`), storage
attribution (`p5`). Not in the default run; select by id or
`--scenario platform`. Full sweep with spread: `scripts/platform-baseline.sh`
(`EXECUTOR`, `LABEL`, `RESULTS`, `REPEAT`, `REPEAT_HC_ON`, `STEPS`), then
`npx tsx src/platform/summarize.ts <results-dir>` writes `SUMMARY.md`. The
summariser reads `<results-dir>/<label>/p*.json` and ignores the `logs` and
`smoke` subdirectories.

- Every P-scenario sets `managesOwnEnvironment` and starts/stops its own
  executor through `src/platform/common.ts` (`launchExecutor`, `stopOwned`)
  so it can restart on the same data dir (`skipInit`). Restarted executors
  need `agent.unlock` (`ensureAgent`).
- CPU is the `/proc` tick delta of the executor **and its descendants** over
  the whole idle window, as % of one core; per-pool CPU uses thread names
  (`threadPool`: trailing digits stripped, `lang-<hash>` → `lang-*`).
- Neighbourhood scenarios skip honestly (`skipped: true`) when
  `LINK_SERVER_URL/health` does not answer or the bundle is missing.
- Run under a memory cap: `systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0 …`
  (or `--unit=<name> --collect` for long sweeps). Each `npx tsx` step
  recompiles `src/`, so do not edit scenario code while a sweep is running.

## Architecture

```
src/
├── main.ts             # Runner: parses flags, boots one executor per scenario
├── client.ts           # InstrumentedClient — WS-RPC wrapper with timing
├── executor.ts         # Executor lifecycle: build / start / waitForHealth / stop
├── scenario.ts         # Scenario + ScenarioContext + ScenarioResult interfaces
├── run-environment.ts  # Commit, machine, Holochain flag, load/swap recorded on every result
├── proc-metrics.ts     # /proc readers: status, threads by pool, CPU ticks, children, smaps, dir sizes
├── platform/
│   ├── common.ts        # Idle windows, owned executors, space creation, markdown helpers
│   ├── summarize.ts     # Spread across --repeat runs → SUMMARY.md / SUMMARY.json
│   └── platform.test.ts # Harness unit tests (npm test)
├── convergence/
│   └── languages.ts     # Registry of convergence languages (bundle path, backend, template params)
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

## RPC and flag drift (ad4m dev, late 2026)

The executor RPC moved under the harness several times. Each of these
silently produced wrong numbers, not errors:

1. **`perspective.queryLinks` takes flat params**: `{uuid, source?, predicate?,
   target?, fromDate?, untilDate?, limit?}`. A nested `query: {...}` is ignored
   by serde, so the filter drops and **every link** comes back.
   `InstrumentedClient.queryLinks(uuid, {source, ...})` sends the flat shape.
2. **`/api/v1/ws/events` is gone.** Events come over the RPC socket only after
   `events.watch {"link-added": null | [uuid]}`; frames are
   `{type: "link-added", perspectiveUuid, link}`. There is no
   `perspective.subscribe_links`. S9 and S10 use `events.watch`.
3. **The server link language template params are `SERVER_URL` and `UID`**
   (was `ROOM_ID`). A wrong name templates nothing and every agent lands in the
   same room.
4. **Bundle and link-server paths follow `AD4M_REPO`.** The default
   `../ad4m` may have another branch checked out; point `AD4M_REPO` (and the
   link-server compose build) at the checkout under test.
5. **`stopExecutor` used to never SIGKILL**: it tested `proc.killed`, which is
   true as soon as SIGTERM is *sent*. `stopExecutorAndWait` waits for the exit
   event and escalates. Always `await` it; executors also run with
   `--exit-with-parent true`.
6. **`waitForHealth` polls every 500 ms by default.** Boot times measured
   with it are quantised to 500 ms; pass `pollMs` (P-scenarios use 25 ms).
7. **`NODE_ENV=production` in the shell makes `pnpm install` skip
   devDependencies**, so the server link language bundle fails to build
   (`@noble/*` missing). Use `NODE_ENV=development pnpm install --prod=false`.
   The same applies to this repo: `npm ci` omits `tsx` and `typescript`
   (`npx tsc` then fails). Use `NODE_ENV=development npm ci --include=dev`.
8. **`language.applyTemplate` uploads to a remote store.** The
   language-language publishes each templated bundle to a public
   Cloudflare-worker store over the internet. Neighbourhood creation time
   includes that round trip, and its transient 5xx errors fail the call;
   `createNeighbourhoodSpace` retries up to 4 times and records the count.
9. **Other executors may share the machine.** Never kill by name; find the
   PID on your port (`lsof -ti:<port>`). The harness only stops processes it
   spawned.
10. **`/health` answers before stored perspectives are open.** After a
    restart, `initialize_from_db` (rust-executor/src/perspectives/mod.rs)
    opens each stored perspective in its own background task. A query that
    arrives first gets `Perspective <uuid> not found` for a perspective that
    exists. With 5,000 links this happened on every run. Use `untilFound`
    (src/platform/common.ts): it retries every 25 ms and counts the 404s. P3
    includes that wait in its time to first answer.
12. **The executor does not flush RocksDB memtables on shutdown.** Writes
    stay in each store's write-ahead log (`perspectives/<uuid>/**/<n>.log`)
    until the next open replays and flushes them. 30 spaces of 1,000 links
    leave ~84 MB of WAL. The first open after writes settles at ~680 MB RSS
    (Holochain off); the next open of the same stores settles at ~345 MB,
    whatever the query pattern. So: (a) compare restarts only on the same
    on-disk state (P3 part B takes one restart for the replay first);
    (b) a store size read right after writing is mostly WAL
    (`perspectiveStoreSizes` returns `walBytes` next to `bytes`).
11. **`src/mcp-client.ts` has 3 `tsc` errors (`'json' is of type 'unknown'`)**
    at HEAD. These errors existed before the platform-baseline changes. `tsx`
    does not check types, so the runner still works.

## Conventions

- Every new scenario must be registered in `src/scenarios/index.ts`.
- Scenarios must skip honestly (record `skipped: true`) when a dependency is
  unreachable — never fabricate a pass.
- Executor flags are chosen at spawn time in the runner/scenario, not read from
  the scenario object after boot.

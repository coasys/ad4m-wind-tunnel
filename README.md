# AD4M Test Suite

Performance testing (Wind Tunnel) and protocol interoperability verification for the [AD4M](https://ad4m.dev) executor and link languages.

## Contents

### 🌪️ Wind Tunnel — Performance Testing

Load testing framework for the AD4M executor, inspired by [Holochain's Wind Tunnel](https://github.com/holochain/wind-tunnel).

```bash
# Install dependencies
npm install

# Run all scenarios against a branch (builds executor ~15min)
./run.sh --branch my-feature

# Compare two branches
./run.sh --branch main --branch my-feature

# Run with pre-built executor (skip build)
./run.sh --skip-build --executor-path /path/to/ad4m-executor

# Run specific scenario
./run.sh --scenario s1

# Run specific scenario against specific branch
./run.sh --branch main --scenario s1
```

#### Scenarios

| ID | Name | Description |
|----|------|-------------|
| S1 | Cold Start | Time from executor start to first successful operations |
| S2 | Link Throughput | Sustained link add/query rate, latency degradation over time |
| S2b | Million Links | Scale to 1M links with checkpoints at 1K/10K/100K/500K/1M |
| S3 | Perspective Scaling | How the executor handles many perspectives (10, 50, 100) |
| S4 | Language Install Storm | Concurrent language installation load |
| S5 | Query Scaling | Query latency vs data size (100, 500, 1000 links) |
| S6 | API Concurrency | Multiple concurrent connections doing mixed operations |
| S7 | Memory Stability | RSS growth over sustained workload (5 min run) |
| S8 | Subject Class Queries | Realistic Flux community graph + SPARQL/link query benchmarks |
| S9 | Neighbourhood Memory Leak | 10k-link neighbourhood perspective + active WS subscription, RSS regression over multi-minute steady-state |
| S15 | Leak Attribution | Fast 3-phase RSS slope split between idle / writes / writes+queries to pinpoint which path leaks |

##### S9/S15 phase tuning

Both leak scenarios expose phase-duration env vars. Defaults (~4 min/mode for S9, ~3.5 min for S15) are tuned for tight inner-loop iteration; bump them up for high-fidelity PR-gate runs.

```bash
# S9 — 4-mode leak isolation (default ≈ 4 min/mode → ~16 min sweep)
S9_MODE=holochain|centralized|local|no-languages
S9_SETTLE_SEC=30    S9_MONITOR_SEC=180    S9_COOLDOWN_SEC=15    # defaults
S9_SETTLE_SEC=60    S9_MONITOR_SEC=600    S9_COOLDOWN_SEC=30    # high-fidelity
S9_MONITOR_QUERY_SEC=30      # query period during monitor (huge value = skip queries)

# S15 — fast 3-phase leak attribution (default ≈ 3.5 min total)
S15_SEED=2000   S15_PHASE_SEC=60   S15_RSS_INTERVAL_SEC=2       # defaults
```

For absolute leak verification: serial S9 sweep across all 4 modes (~16 min default, ~30 min high-fidelity). For inner-loop dev iteration: S15 (~3.5 min, attributes the leak to write vs query path automatically).
| M1 | Neighbourhood Sync | Dual-executor neighbourhood create/join/sync |
| M2 | Multi-Executor Scale | 3 executors, cross-interference measurement |
| M3 | Link Language Comparison | Docker infra startup + local baseline comparison |
| M4 | Write Load Under Sync | Dual-executor concurrent write interference measurement |
| M5 | Concurrent Neighbourhoods | 3 executors × 3 perspectives concurrent load |
| A1 | MCP Throughput | AI tool call latency via MCP protocol |
| W1 | WE Space RPC Footprint | The real WE web app (Chromium, headless) opening, idling on and clicking through a populated WE space; every executor WebSocket frame recorded via CDP |

##### W1 — WE space RPC footprint

Drives the complete WE web app against a fresh executor and records every WebSocket frame on the
executor socket from Chromium's own network layer (CDP `Network.webSocket*`): method, JSON-RPC id,
params/response size, latency (request↔response paired by id), pushed events by type, sockets
opened, reconnects, HTTP to the executor, executor RSS/CPU (`/proc`) and browser heap/script time.

```bash
# Prerequisites (once per checkout):
#   ad4m:  pnpm install; (cd core && pnpm run build); (cd connect && pnpm run build); executor built
#   WE:    unset NODE_ENV; pnpm install && pnpm build:web
#   here:  npm install            (playwright-core; uses Playwright's cached Chromium, or W1_CHROME)
AD4M_REPO=/path/to/ad4m WE_REPO=/path/to/we \
  ./run.sh --skip-build --executor-path /path/to/ad4m/target/release/ad4m-executor \
  --scenario w1 --branch w1-run1
```

Flow: mint a WE capability JWT (`agent.requestCapability` → `permitCapability` → `generateJwt`, with
WE's own app info) and put it where ad4m-connect keeps it (`<connect version>/ad4m-token`,
`/ad4m-url`, `/ad4m-port` in localStorage) → build WE web in production mode with a generated
wrapper Vite config (SDK aliased to the executor's ad4m checkout; the WE tree is not modified) and
serve it with `vite preview` → **seed (not measured)**: create the space through WE's UI (name
prompt, rail "+", Create a space, Shared), then write channels, messages, replies, likes, tasks and
events through WE's own packages (`@we/block-shared` `createBlocks`, the entity classes registered
by `@we/backend-ad4m`). The first `W1_DISTINCT_BODIES` messages go through `createBlocks`; the rest
are batched copies of those (same model calls, the `we://editor_state` link pointing at an uploaded
file), checked link-for-link against their exemplar, then containment, reply and like counts are
verified. The defaults (300 messages, 120 replies) seed in about 2 minutes → **measure** in a new browser context with the same
localStorage/IndexedDB (a returning user, cold HTTP cache):

- **A — cold open:** `goto /space/<uuid>` → ready signal (DOM: the first seeded task card on
  Workshop's canvas, or the last channel in the Discord rail) → `W1_SETTLE_MS`. Reported both "to
  ready" and whole.
- **B — idle:** `W1_IDLE_MS` with no input; per-second call counts.
- **C — interaction:** each step its own sub-phase — Workshop: Kanban, scroll, Calendar, Flows,
  Canvas, scroll; Discord: every channel, scroll up, back to #general, scroll.

Output in `results/<branch>/`: `w1-we-space-rpc.json` (runner result: per-phase aggregates),
`w1-we-space-rpc.raw.json` (every call and frame) and `w1-we-space-rpc.md` (per phase: methods by
count with total/avg/p95 latency and bytes, the top repeated identical calls — same method + same
params hash — events by type, totals). Repeat with a different `--branch` label per run.

| Env | Default | Meaning |
|---|---|---|
| `WE_REPO` / `--we-repo` | *(required; skips without)* | WE monorepo checkout (built) |
| `W1_SDK` | `executor` | `executor`: alias `@coasys/ad4m`/`-connect` to the ad4m checkout (`W1_AD4M_SDK_REPO`, else `AD4M_REPO`, else the checkout the executor binary sits in); `pinned`: WE's own pin |
| `W1_WE_MODE` | `preview` | `preview` = production build + `vite preview`; `dev` = Vite dev server |
| `W1_WE_PORT` | base port + 50 | Port WE is served on (dev also uses +1 for HMR) |
| `W1_ACCESS` | `shared` | `shared` (neighbourhood) or `personal` space |
| `W1_TEMPLATE` | *(starter's: workshop)* | Override `Space.defaultTemplateId`, e.g. `discord` for the channel/message view |
| `W1_CHANNELS` / `W1_MESSAGES` | `4` / `75` | Channels, and messages per channel |
| `W1_REPLY_EVERY` / `W1_REPLIES` | `5` / `2` | Every Nth message gets this many replies |
| `W1_SIGNAL_EVERY` | `3` | Every Nth message gets a Like |
| `W1_TASKS` / `W1_EVENTS` | `24` / `8` | Tasks and events in the space collection |
| `W1_DISTINCT_BODIES` | `24` | Messages written through `createBlocks` with their own editor-state upload; every other message/reply reuses one of those bodies (same model calls, batched, no upload). `0` = all through `createBlocks` (~1.4 s each, ~10 min for the defaults) |
| `W1_SEED_BATCH` | `25` | Pooled messages per write batch |
| `W1_SEED_CONCURRENCY` | `6` | Real messages (or pooled batches) in flight; real uploads serialise in the file-storage language, and far more than 6 pass the SDK's 30 s call timeout |
| `W1_IDLE_MS` / `W1_SETTLE_MS` / `W1_STEP_MS` | `60000` / `5000` / `5000` | Phase B length, A settle after ready, wait after each C step |
| `W1_READY_TEXT` / `W1_STEPS` | *(per template)* | Comma lists overriding the ready signal / the steps (`@scroll` = wheel) |
| `W1_WARM` | `1` | `0` = measure a first-ever open (token only, no stored app state) |
| `W1_CHROME` | *(Playwright's Chromium)* | Browser executable |
| `W1_WE_REBUILD` | `0` | `1` = rebuild WE even if a build for the same commits exists |

Shared spaces need a WE that reads `runtime.linkLanguageTemplates` as `LanguageMeta[]` (coasys/we#349)
when the executor includes coasys/ad4m#1466; older WE fails `createSpace` with
`Invalid params for language.applyTemplate`.

#### Results

Results are written to `results/<branch-name>/` (branch slashes replaced with dashes). Run `npx tsx src/report.ts` to regenerate `results/comparison.md`.

#### Architecture

```
src/
├── main.ts           # Runner/orchestrator
├── client.ts         # Instrumented AD4M client (WebSocket RPC)
├── executor.ts       # Executor lifecycle management (build/start/stop)
├── scenario.ts       # Scenario interface
├── reporters.ts      # Console + JSON reporters
├── report.ts         # Comparison report generator
├── w1/               # W1 helpers: WE build/serve, auth, seeding, CDP WS recorder, analysis
└── scenarios/        # All scenario implementations
```

---

### 🔌 Link Language Interoperability Tests

Proves each AD4M link language correctly reads/writes to its native protocol backend — verifying that data written in AD4M appears in native apps, and vice versa.

#### Link Languages

| Protocol | Repo | Transport | Native App |
|----------|------|-----------|------------|
| **Matrix** | [matrix-link-language](https://github.com/coasys/matrix-link-language) | HTTP (Client-Server API) | [Element](https://app.element.io) |
| **Nostr** | [nostr-link-language](https://github.com/coasys/nostr-link-language) | Native WebSocket + BIP-340 Schnorr | [Snort](https://snort.social) |
| **AT Protocol** | [atproto-link-language](https://github.com/coasys/atproto-link-language) | HTTP (XRPC) | [Bluesky](https://bsky.app) |
| **IPFS** | [ipfs-link-language](https://github.com/coasys/ipfs-link-language) | HTTP (Kubo API) | [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/) |
| **Solid** | [solid-link-language](https://github.com/coasys/solid-link-language) | HTTP (LDP) | [Penny](https://penny.vincenttunru.com/) |
| **Hypercore** | [hypercore-link-language](https://github.com/coasys/hypercore-link-language) | HTTP → sidecar gateway | [hyp CLI](https://docs.holepunch.to/) |
| **ActivityPub** | [ap-link-language](https://github.com/coasys/ap-link-language) | HTTP (AP federation) | [Mastodon](https://joinmastodon.org) |
| **NextGraph** | [nextgraph-link-language](https://github.com/coasys/nextgraph-link-language) | Websockets | [NextGraph](https://nextgraph.org/) |
| **Holochain** | [p-diff-sync](https://github.com/coasys/ad4m/tree/dev/bootstrap-languages/p-diff-sync) | Kitsune (Iroh) | [Holochain Launcher](https://www.holochain.org/) |
| **Git** | [git-link-language](https://github.com/coasys/git-link-language) | Local filesystem (Git repo) ¹ | [`git` CLI](https://git-scm.com/) |
| **peer2panda** | [peer2panda-link-language](https://github.com/coasys/peer2panda-link-language) | HTTP → sidecar gateway (Rust p2panda / iroh QUIC) | [p2panda](https://p2panda.org) |
| **Anytype** | [anytype-link-language](https://github.com/coasys/anytype-link-language) | HTTP → sidecar gateway (Go any-sync) | [Anytype](https://anytype.io) |
| **Freenet** | [freenet-link-language](https://github.com/coasys/freenet-link-language) | HTTP → sidecar gateway (Rust freenet-stdlib) + WASM contract | [Freenet](https://freenet.org) |

¹ v1 is local-first: the convergent OR-Set remote-merge logic is wired and tested, but the automated `git fetch`/`push` transport gates on a binary HTTP host enhancement, so peers exchange commits out-of-band (shared filesystem, external `git pull`) in v1. See [Remote sync](https://github.com/coasys/git-link-language/blob/main/README.md#remote-sync).

See [`CAPABILITIES.md`](CAPABILITIES.md) for a full capability matrix across all 13 languages.

#### Single-Device Backend Verification (`interop/`)

Runs each language against Docker-hosted backend services on a single machine:

```bash
cd interop
./setup.sh          # Start all backend services (Docker)
./verify-matrix.sh  # Test Matrix → Conduit
./verify-nostr.sh   # Test Nostr → nostr-rs-relay
./verify-atproto.sh # Test AT Proto → self-hosted PDS
./verify-ipfs.sh    # Test IPFS → Kubo
./verify-solid.sh   # Test Solid → CSS pod
./verify-hypercore.sh # Test Hypercore → sidecar gateway
./verify-git.sh     # Test Git → local repo (no Docker, no daemon)
./verify-peer2panda.sh # Test peer2panda → Rust sidecar gateway (no Docker)
./verify-anytype.sh # Test Anytype → Go sidecar gateway (any-sync, no Docker)
./verify-freenet.sh # Test Freenet → Rust sidecar gateway + WASM contract (local node, no Docker)
./teardown.sh       # Stop all services

# Expression language verification (no Docker required)
./verify-expression-literal.sh           # literal://<type>:<value>
./verify-expression-language-language.sh # Qm… bootstrap language addresses
./verify-expression-git.sh               # git+https://<host>/<o>/<r>.git#<ref>:<path>
```

Expression languages resolve URIs to `Expression` records on demand and do not require backend infrastructure beyond what the URI scheme targets (`literal://` is in-executor; `language-language` reaches the bootstrap CDN; `git+https://` reaches the named Git host's REST API).

See [`interop/README.md`](interop/README.md) for detailed setup and per-protocol notes.

#### Multi-Device Sync Tests (`scripts/`)

Proves bidirectional Perspective sync between two AD4M executors on different machines:

```bash
cp config.example.env config.env
# Edit with device IPs and language addresses
./scripts/run-tests.sh              # Run all
./scripts/run-tests.sh -l nostr     # Single language
```

#### Infrastructure (`infra/`)

Docker Compose files for each protocol backend:
- `infra/docker-compose.matrix.yml` — Conduit homeserver
- `infra/docker-compose.nostr.yml` — nostr-rs-relay
- `infra/docker-compose.atproto.yml` — Self-hosted PDS
- `infra/docker-compose.ipfs.yml` — Kubo node
- `infra/docker-compose.solid.yml` — Community Solid Server

See [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md) for full deployment guide.

---

### 🤖 Agent-Harness Wind Tunnel (A-series)

Three external AI agent harnesses — **OpenClaw, Hermes, Sovereign** — each drive an
ADAM node across the real integration surface (init/connect, MCP, waker, and a
mocked audio/video action loop). Every harness runs inside its own hardened Docker
pod against a containerised executor; a mock LLM (`interop/agents/mock-llm/`, both
OpenAI and Anthropic wire formats) makes every non-model failure reproducible. The
only mocks stay at the two chosen edges: the A/V transport and the LLM.

```bash
./run.sh --scenario a2   # provision & connect
./run.sh --scenario a3   # MCP action round-trip
./run.sh --scenario a4   # waker
./run.sh --scenario a5   # A/V action loop (mocked)
```

Each scenario stands up + tears down its own pod (`interop/agents/verify-*.sh`);
`KEEP=1` leaves a pod up for debugging. Set `AD4M_PLUGIN_DIR` to a `plugins/ad4m`
checkout for the waker routes. A route whose image or dependency is absent skips
honestly.

| ID | Scenario | OpenClaw | Hermes | Sovereign |
|----|----------|----------|--------|-----------|
| **A2** | Provision & connect | ✅ | ✅ | ✅ |
| **A3** | MCP action round-trip | ✅ | ✅ | ✅ |
| **A4** | Waker | ✅ | ✅ | ✅ |
| **A5** | A/V loop (mocked) | ◑ wake only | ✅ full loop | ✅ full loop |

**A5 — A/V action loop (mocked).** The agent wakes on a mocked call-presence
entry, reads a transcript that names it in free speech ("… hey Aria, can you
summarise the last point?"), and replies in chat — all as ordinary AD4M
perspective links / `Message` expressions (`interop/agents/mock-av.ts`). Only the
media transport is mocked; presence, transcript, and reply are real channel
writes, so the true perceive→act loop runs over MCP. A negative control proves the
wake rides the transcript's spoken name (the call-presence entry alone never
wakes), not mere channel activity. Cross-user visibility needs neighbourhood sync
and stays out of scope — A5 asserts the reply lands + reads back.

- **Sovereign (full loop)** — the native in-server waker wakes the presence agent
  on the spoken name; it replies via `presence_reply_ad4m`, which posts a child
  back into the channel. Perceive rides content-gating (the presence turn exposes
  only presence tools, so the wake, not an explicit read, carries the transcript).
- **Hermes (full loop)** — the real ad4m mention waker → signed webhook → a Hermes
  turn (`mcp_servers.ad4m`) that reads the transcript (`query_links`) then writes
  the reply. Perceive is an explicit agent read before the write.
- **OpenClaw (wake only)** — the real ad4m mention waker → OpenClaw's real
  `/hooks/wake` ingress, with the negative control. The perceive→act-via-MCP half
  is **not** driven on the mock lane: OpenClaw lists MCP tools in the system prompt
  and drives them through its own text / code-bridge protocol (not OpenAI
  `tool_calls`), and its hook turn surfaces no model-visible prompt — so the
  deterministic mock cannot make it act. That half rides the real-model lane, where
  the reference `@coasys/openclaw-ad4m` plugin registers ad4m tools natively.

---

## Configuration

All machine-specific values are configurable. CLI args take precedence over environment variables.

| Env Var | CLI Arg | Default | Description |
|---------|---------|---------|-------------|
| `AD4M_REPO` | `--ad4m-repo` | *(required for builds)* | Path to local AD4M repo (for `cargo build`) |
| `AD4M_ADMIN_TOKEN` | `--admin-token` | `test123` | Admin credential for executor auth |
| `AD4M_WT_TMPDIR` | `--tmp-dir` | OS temp dir | Base directory for temporary data and build dirs |
| `AD4M_WT_BASE_PORT` | `--base-port` | `12100` | Starting port for executor instances |
| `AD4M_WT_RESULTS_DIR` | `--results-dir` | `./results` | Where to write JSON result files |
| `WE_REPO` | `--we-repo` | *(none)* | WE monorepo checkout, for W1 |

### Pre-built executor

To skip building from source, use `--skip-build` with `--executor-path`:

```bash
./run.sh --skip-build --executor-path /path/to/ad4m-executor --scenario s1
```

### Interop scripts

The shell scripts in `interop/` and `scripts/` use these env vars:

| Env Var | Default | Description |
|---------|---------|-------------|
| `WORKSPACE` | Parent of this repo | Root directory containing sibling repos |
| `AD4M_DIR` | `$WORKSPACE/ad4m` | Path to AD4M repo |
| `FLUX_DIR` | `$WORKSPACE/flux` | Path to Flux repo |
| `MATRIX_LANG_DIR` | `$WORKSPACE/matrix-link-language` | Path to matrix-link-language repo |
| `AD4M_TOKEN` | `test123` | Admin token for executor |

## Requirements

- Node.js 20+
- Rust toolchain (for building executor — Wind Tunnel only)
- Docker + Docker Compose (for interop tests)
- AD4M repo (set `AD4M_REPO` or use `--executor-path` with a pre-built binary)

## License

MIT

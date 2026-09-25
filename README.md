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
| M1 | Neighbourhood Sync | Dual-executor neighbourhood create/join/sync |
| M2 | Multi-Executor Scale | 3 executors, cross-interference measurement |
| M3 | Link Language Comparison | Docker infra startup + local baseline comparison |
| M4 | Write Load Under Sync | Dual-executor concurrent write interference measurement |
| M5 | Concurrent Neighbourhoods | 3 executors × 3 perspectives concurrent load |
| A3 | MCP Throughput | AI tool call latency via MCP protocol |
| U1 | WE Call Transcription | WE in Chrome with ad4m-devtools: create a space, open Workshop, join a call, transcribe real speech; report redundant and expensive RPC calls. Opt-in — see below |

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

##### U1 — WE call + transcription RPC report

U1 runs a real WE session against the executor and reports what WE asked for. It serves WE's web app
from a WE checkout with Vite, opens it in Chrome with the ad4m-devtools bridge injected (the script the
devtools extension injects), and acts as a new user:

1. The operator installs a Whisper model on the node and creates a user (WS-RPC, before WE opens).
2. WE boots signed in as that user; the user sets a display name.
3. The user creates a shared space from the sidebar and opens it.
4. The user switches the space to the **Workshop** template.
5. The user starts a call. WE starts transcription on its own (U1 presses the call bar's record toggle if it does not).
6. Chrome's fake microphone plays a recorded sentence on a loop, and the executor transcribes it with Whisper.
7. The user leaves the call; U1 records 15 s more of background traffic.

```bash
# U1 runs only when named. WE must be installed and built (pnpm install && pnpm setup-workspace).
WE_REPO=../we AD4M_REPO=../ad4m ./run.sh --skip-build --executor-path /path/to/ad4m-executor --branch dev --scenario u1
```

It writes `results/<branch>/u1/`:

| File | Content |
|------|---------|
| `rpc-report.md` | Verdict, per-phase totals, then redundant calls (same call and same answer, identical calls in flight, polling loops, N+1 fan-out bursts, identical writes, duplicate live subscriptions), expensive calls (slowest, heaviest methods, largest payloads), push-event volume with repeated deliveries, and the transcript. Each finding names the WE source lines that made the call. |
| `rpc-calls.json` | Every call, event count, phase and step behind the report |
| `<n>-<step>.png` | A screenshot after each step; `failed-<step>.png` + `.ui.txt` on failure |

U1 passes when every step completes, the transcript contains ≥ 80% of the spoken words, WE shows the
transcribed text, and the bridge logged every request the wire carried.

| Env var | Default | Description |
|---------|---------|-------------|
| `WE_REPO` | `../we` | WE checkout to serve (`apps/we-web`) |
| `AD4M_DEVTOOLS` | `../ad4m-devtools` | ad4m-devtools checkout; its bridge is rebuilt (with `pnpm`) when its source is newer than its build |
| `U1_SPEECH_AUDIO` | `$AD4M_REPO/tests/transcription_test.m4a` | Speech clip for the fake microphone (any format ffmpeg reads) |
| `U1_SPEECH_TEXT` | `If you can read this, transcription is working.` | What the clip says |
| `U1_WHISPER_MODEL` | `whisper_small` | The model WE's "Add a model" installs. The first run downloads it (~1 GB) |
| `U1_TRANSCRIBE_SECONDS` | `60` | How long the call is transcribed |
| `U1_CHROME` | system Chrome/Chromium | Browser binary; unset and none found = Playwright's Chromium (`npx playwright-core install chromium`) |
| `U1_HEADED` | unset | `1` shows the browser |
| `FFMPEG` | `ffmpeg` | ffmpeg binary |

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
├── scenarios/        # All scenario implementations
└── we/               # U1: WE dev server, browser driving, devtools capture, RPC analysis + report
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

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
└── scenarios/        # All scenario implementations
```

---

### 🔌 Link Language Interoperability Tests

Proves each AD4M link language correctly reads/writes to its native protocol backend — verifying that data written in AD4M appears in native apps, and vice versa.

#### Link Languages

| Protocol | Repo | Transport | Native App |
|----------|------|-----------|------------|
| **Matrix** | [matrix-link-language](https://github.com/HexaField/matrix-link-language) | HTTP (Client-Server API) | [Element](https://app.element.io) |
| **Nostr** | [nostr-link-language](https://github.com/HexaField/nostr-link-language) | Native WebSocket + BIP-340 Schnorr | [Snort](https://snort.social) |
| **AT Protocol** | [atproto-link-language](https://github.com/HexaField/atproto-link-language) | HTTP (XRPC) | [Bluesky](https://bsky.app) |
| **IPFS** | [ipfs-link-language](https://github.com/HexaField/ipfs-link-language) | HTTP (Kubo API) | [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/) |
| **Solid** | [solid-link-language](https://github.com/HexaField/solid-link-language) | HTTP (LDP) | [Penny](https://penny.vincenttunru.com/) |
| **Hypercore** | [hypercore-link-language](https://github.com/HexaField/hypercore-link-language) | HTTP → sidecar gateway | [hyp CLI](https://docs.holepunch.to/) |
| **ActivityPub** | [ap-link-language](https://github.com/HexaField/ap-link-language) | HTTP (AP federation) | [Mastodon](https://joinmastodon.org) |
| **NextGraph** | [nextgraph-link-language](https://github.com/HexaField/nextgraph-link-language) | Websockets | [NextGraph](https://nextgraph.org/) |
| **Holochain** | [p-diff-sync](https://github.com/coasys/ad4m/tree/dev/bootstrap-languages/p-diff-sync) | Kitsune (Iroh) | [Holochain Launcher](https://www.holochain.org/) |

See [`CAPABILITIES.md`](CAPABILITIES.md) for a full capability matrix across all 8 languages.

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
./teardown.sh       # Stop all services
```

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

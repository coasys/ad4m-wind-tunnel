# AD4M Link Language Test Suite

End-to-end verification that [AD4M](https://ad4m.dev) link languages correctly bridge Perspectives to native protocol backends — proving data written in AD4M appears in each protocol's native apps, and vice versa.

## What Are Link Languages?

AD4M's core data unit is the **link triple** `(source, predicate, target)`. A **link language** is a protocol adapter that syncs these triples to an external backend — a Matrix room, a Nostr relay, an AT Proto PDS, an IPFS DAG, a Solid pod, or a Hypercore feed.

Each language is a self-contained bundle that runs inside the AD4M executor's sandboxed Deno runtime. It uses the [AD4M Language Development Kit (ALDK)](https://github.com/coasys/ad4m/tree/dev/ad4m-ldk) and communicates with its backend via `httpFetch` (HTTP) or native WebSocket.

## Link Languages

| Protocol | Repo | Transport | Native App |
|----------|------|-----------|------------|
| **Matrix** | [matrix-link-language](https://github.com/HexaField/matrix-link-language) | HTTP (Client-Server API) | [Element](https://app.element.io) |
| **Nostr** | [nostr-link-language](https://github.com/HexaField/nostr-link-language) | Native WebSocket + BIP-340 Schnorr | [Snort](https://snort.social), [Iris](https://iris.to) |
| **AT Protocol** | [atproto-link-language](https://github.com/HexaField/atproto-link-language) | HTTP (XRPC) | [Bluesky](https://bsky.app) |
| **IPFS** | [ipfs-link-language](https://github.com/HexaField/ipfs-link-language) | HTTP (Kubo API) | [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/) |
| **Solid** | [solid-link-language](https://github.com/HexaField/solid-link-language) | HTTP (LDP) | [Penny](https://penny.vincenttunru.com/) |
| **Hypercore** | [hypercore-link-language](https://github.com/HexaField/hypercore-link-language) | HTTP → sidecar gateway | [hyp CLI](https://docs.holepunch.to/) |
| **ActivityPub** | [ap-link-language](https://github.com/HexaField/ap-link-language) | HTTP (AP federation) | [Mastodon](https://joinmastodon.org) |
| **Holochain** | [ad4m/bootstrap-languages/p-diff-sync](https://github.com/coasys/ad4m/tree/dev/bootstrap-languages/p-diff-sync) | Holochain (built-in) | Flux |

**Starting a new language?** Use the [ad4m-link-language-template](https://github.com/HexaField/ad4m-link-language-template) — modern ALDK pattern with `defineLanguage()`, esbuild, pure/impure separation, and 20 passing tests out of the box.

## Basic Usage

Every link language follows the same lifecycle:

```
1. Publish   →  language.publish(bundlePath, meta)
2. Configure →  language.applyTemplate(hash, templateData)
3. Create    →  perspective.create + neighbourhood.publish
4. Use       →  perspective.addLink / perspective.queryLinks
```

**Publish** the bundle to the executor, **configure** it with template variables (server URLs, credentials, namespace IDs), attach it to a **Perspective** as a Neighbourhood, then **add links** — the language handles syncing to the backend.

Template variables are protocol-specific. For example:

| Language | Key Template Variables |
|----------|----------------------|
| Matrix | `MATRIX_HOMESERVER_URL`, `MATRIX_ROOM_ID`, `MATRIX_ACCESS_TOKEN` |
| Nostr | `NOSTR_RELAY_URLS`, `NOSTR_PRIVKEY` |
| AT Proto | `AT_PDS_URL`, `AT_HANDLE`, `AT_APP_PASSWORD` |
| IPFS | `IPFS_API_URL` |
| Solid | `SOLID_POD_URL`, `SOLID_CONTAINER_PATH` |
| Hypercore | `HYPERCORE_GATEWAY_URL` |
| ActivityPub | `GROUP_ACTOR_URL`, `GROUP_INBOX_URL`, `FEDERATION_DOMAIN` |

## This Repository

### `interop/` — Single-Device Backend Verification

Proves each language correctly writes to and reads from its native backend. Runs against Docker services on a single machine.

```bash
cd interop
./setup.sh          # Start all backend services
./verify-matrix.sh  # Test Matrix
./verify-nostr.sh   # Test Nostr
# ... etc
./teardown.sh       # Clean up
```

See [`interop/README.md`](interop/README.md) for full details, Docker Compose setup, and per-protocol notes.

### `scripts/` — Multi-Device Sync Tests

Proves Perspective sync works between two separate AD4M executors on different machines. Creates a Neighbourhood on Device A, joins on Device B, and verifies bidirectional link propagation.

```bash
cp config.example.env config.env
# Edit config.env with your device IPs and language addresses
./scripts/run-tests.sh              # Run all
./scripts/run-tests.sh -l nostr     # Single language
```

## Architecture

All languages share the same internal architecture:

```
index.ts                    ← defineLanguage() entry point
src/
├── types.ts                ← Shared types (pure)
├── store.ts                ← Link store + indexed queries (pure)
├── transport.ts            ← Transport interface + singleton
├── transport-deno.ts       ← httpFetch wrapper (Deno adapter)
├── storage-interface.ts    ← Storage interface + singleton
├── storage-deno.ts         ← storageGet/Put/Delete (Deno adapter)
├── sync.ts                 ← Protocol-specific sync logic
├── *.pure.ts               ← Pure modules (no runtime imports)
└── *-deno.ts               ← Deno/executor adapters only
```

**Pure/impure boundary**: `.pure.ts` files import only from other `.pure.ts`, `types.ts`, or external packages. Adapter files (`*-deno.ts`) are the only place `ad4m:host` imports appear.

## License

MIT

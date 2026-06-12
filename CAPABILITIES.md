# Link Language Capability Matrix

How each AD4M link language compares across protocol characteristics, security properties, and AD4M capabilities.

## Quick Reference

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|
| **Repo** | [p-diff-sync](https://github.com/coasys/ad4m/tree/dev/bootstrap-languages/p-diff-sync) | [matrix](https://github.com/coasys/matrix-link-language) | [nostr](https://github.com/coasys/nostr-link-language) | [atproto](https://github.com/coasys/atproto-link-language) | [ipfs](https://github.com/coasys/ipfs-link-language) | [solid](https://github.com/coasys/solid-link-language) | [hypercore](https://github.com/coasys/hypercore-link-language) | [ap](https://github.com/coasys/ap-link-language) | [nextgraph](https://github.com/coasys/nextgraph-link-language) | [git](https://github.com/coasys/git-link-language) |
| **Runtime** | WASM (Holochain) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) |
| **Status** | Production | Verified | Verified | Verified | Verified | Verified | Verified | Verified | Alpha | Verified (v0.1, local) |

---

## Network Topology

How data moves between participants.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|
| **Topology** | P2P (DHT) | Federated | Relay | Cloud/Federated | P2P (DHT) | Client-Server | P2P (DHT) | Federated | P2P (CRDT mesh) | Local-first (Git repo) ¹⁴ |
| **Infrastructure** | None (public bootstrap) | Homeserver | Relay(s) | PDS + Relay | Kubo daemon | Pod server | Sidecar gateway | None (executor built-in) | Sidecar gateway (NextGraph WASM) | None |
| **Self-hostable** | N/A | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | N/A | ✅ | ✅ (any Git host) |
| **Works offline** | Partial ¹ | ❌ | ❌ | ❌ | Partial ² | ❌ | Partial ¹ | ❌ | ✅ (local-first CRDT) | ✅ |
| **NAT traversal** | ✅ (Holochain proxy) | N/A (server) | N/A (relay) | N/A (server) | ✅ (libp2p) | N/A (server) | ✅ (Hyperswarm) | N/A (server) | ✅ (NextGraph broker) | N/A ¹⁵ |

¹ Local reads work; writes queue until reconnected to DHT / peers.
² Local pinned content readable; writes need API access.
¹⁴ v1 is pure local — no network operations. Out-of-band sync (shared filesystem, external `git pull`) carries the data; automated remote sync via HTTP gates on a binary HTTP host enhancement.
¹⁵ No network operations in v1.

---

## Identity & Authentication

How participants are identified and authenticated.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|
| **Native identity** | AgentPubKey (Ed25519) | MXID (`@user:server`) | npub (secp256k1) | DID (did:plc / did:web) | PeerID (libp2p) | WebID (URI) | Feed public key | Actor URI | NextGraph Wallet (Ed25519) | Git committer (DID-derived) |
| **AD4M identity** | DID (mapped via zome) | DID (embedded in events) | DID (embedded in events) | DID (embedded in records) | DID (embedded in DAG) | DID (embedded in RDF) | DID (embedded in blocks) | DID (extracted from actors) | DID (embedded in triples) | DID (link expression proof + commit author) |
| **Sovereign identity** | ✅ ³ | ❌ ⁴ | ✅ | ❌ ⁵ | ✅ | ❌ ⁶ | ✅ | ❌ ⁷ | ✅ | ✅ ¹⁶ |
| **Auth mechanism** | Membrane proof | Access token | Keypair (BIP-340) | App password + session | None (public API) | WebID-OIDC / token | Feed key possession | HTTP Signatures | Wallet password | AD4M agent keypair |

³ AgentPubKey is self-generated; no registration authority.
⁴ MXID is server-issued; identity is portable across servers only via migration.
⁵ did:plc resolution depends on plc.directory; did:web depends on DNS. Portable but not fully sovereign.
⁶ WebID is server-hosted; identity depends on pod provider.
⁷ Actor URI is domain-bound; identity depends on the hosting server.
¹⁶ The Git committer field encodes the AD4M agent DID. No registration authority; identity is self-generated.

---

## Security & Encryption

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|
| **Transport encryption** | ✅ (TLS to bootstrap/proxy) | ✅ (HTTPS to homeserver) | ✅ (WSS to relay) | ✅ (HTTPS to PDS) | Varies ⁸ | ✅ (HTTPS to pod) | ✅ (Noise protocol) | ✅ (HTTPS) | ✅ (TLS to broker) | N/A ¹⁵ |
| **E2E encryption** | ❌ ⁹ | Configurable ¹⁰ | ❌ ¹¹ | ❌ | ❌ | ❌ | Configurable ¹² | ❌ | ✅ (wallet-level) | N/A ¹⁵ |
| **Content signing** | ✅ (Holochain DHT) | ✅ (AD4M proof) | ✅ (Schnorr BIP-340) | ✅ (AT repo signing) | ✅ (content-addressed) | ✅ (AD4M proof) | ✅ (feed signature) | ✅ (HTTP Signatures) | ✅ (AD4M proof) | ✅ (AD4M proof + commit hash chain) |
| **Data at rest** | Encrypted (conductor DB) | Server-controlled | Relay-controlled | PDS-controlled | Public (content-addressed) | Pod-controlled | Configurable ¹² | Server-controlled | Encrypted (wallet) | Filesystem ACL (executor data dir) |
| **Data deletion** | ❌ (DHT, eventual) | ✅ (redaction) | ✅ (replaceable events) | ✅ (repo delete) | ❌ (content-addressed) | ✅ (resource delete) | ❌ (append-only) | ✅ (Delete activity) | ✅ (CRDT remove) | ✅ (forward-inverse commit; history preserved) |

⁸ Kubo API is typically HTTP (localhost); swarm connections use libp2p encryption.
⁹ DHT entries are public to the network; the DNA hash acts as a namespace boundary, not an encryption boundary.
¹⁰ Matrix language has E2EE settings (`encryption.enabled`), wrapping content in encrypted room events. Requires Olm/Megolm key exchange.
¹¹ Nostr supports NIP-04/NIP-44 encrypted DMs at the protocol level, but the link language currently uses public events (kind:30078).
¹² Hypercore language supports symmetric key encryption of feed blocks (`encryption.ts`). Peers must share the key out-of-band.

---

## AD4M Capabilities

What each language implements from the AD4M Language Interface.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|
| **perspective-commit** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (one commit per diff) |
| **perspective-sync** | ✅ (gossip) | ✅ (timeline poll) | ✅ (REQ filter) | ✅ (repo list) | ✅ (IPNS resolve) | ✅ (container list) | ✅ (feed poll) | ✅ (outbox poll) | ✅ (CRDT auto-sync + gateway poll) | ✅ (local HEAD-movement) ¹⁷ |
| **perspective-query** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ + 3 custom kinds ¹⁸ |
| **peers** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **telepresence** | ✅ (native DHT) | ✅ (Presence API) | ✅ (ephemeral events) | ❌ | ✅ (PubSub) | ❌ | ✅ (Hyperswarm peers) | ❌ | ❌ | ❌ |
| **interactions** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (`flush`, `revert-to`, `tag`) |
| **dual-language** | N/A (primary) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **sync modes** | Bidirectional | Bi / Pub / Sub | Bi / Pub / Sub | Bi / Pub / Sub | Bi / Pub / Sub | Bi / Pub / Sub | Bi / Pub / Sub | Bi / Pub / Sub | Bidirectional | Local (out-of-band) ¹⁷ |

**Telepresence** = real-time presence and signalling (online status, peer-to-peer signals, broadcast). Implemented via:
- **Holochain**: DHT-based `get_online_agents` + `send_signal` zome calls
- **Matrix**: Presence API (`/_matrix/client/v3/presence`) + to-device messages for signalling
- **Nostr**: Ephemeral events (kind 20042-20044, NIP-16) via WebSocket subscriptions
- **Hypercore**: Hyperswarm peer tracking via sidecar gateway REST API

AT Proto, IPFS, Solid, ActivityPub, and NextGraph lack a real-time bidirectional channel suitable for presence — AT Proto's firehose is one-way, IPFS PubSub is experimental, Solid notifications are container-level, AP is HTTP push only, and NextGraph does not yet expose ephemeral messaging APIs to the client SDK.

**Interactions** = protocol-specific actions exposed to the UI (e.g. "invite user", "pin message"). Primarily useful for expression languages, not link languages — link language operations are handled through the perspective API (`addLink`, `queryLinks`, etc.).

**Dual-language** = can coexist alongside Holochain (p-diff-sync) in the same Neighbourhood, with origin tracking to prevent echo loops. Holochain is the primary language, so dual-language doesn't apply to it.

NextGraph telepresence may be added in future versions if native support is added to the SDK or via a secondary layer (e.g. libp2p).

¹⁷ Git's `sync()` detects HEAD movement applied externally (`git pull` from a shell, or shared storage between agents) and emits the resulting PerspectiveDiff. Automated `fetch`/`push` is wired through the architecture but gated on a binary HTTP host enhancement — `httpFetch` UTF-8-decodes response bodies and mangles Git pack files (see [git-link-language §11.2](https://github.com/coasys/git-link-language)). Out-of-band sync mechanisms (shared filesystem, Syncthing, external `git pull`) are how peers exchange state in v1.

¹⁸ Git is the first language to ship custom `perspective-query` kinds beyond `link-pattern`:
- `git-history` — walks the commit DAG, returns CommitRecords with link-hash additions/removals
- `git-state-at` — renders the Perspective as it existed at any past SHA
- `git-blame` — locates the commit that introduced a given link hash

It's also the first to expose **interactions** as a primary feature (`revert-to` computes a forward inverse and commits it; `tag` creates a Git tag; `flush` reserved for the binary-HTTP-unlocked future).

---

## Access Control & Membership

How each language controls who can read and write.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|
| **Read access** | DNA hash (namespace) | Room membership | Public ¹³ | Public ¹³ | Public (CID) | ACL (WAC) | Feed key | Public | Wallet ReadCap | Filesystem / Git host ACL |
| **Write access** | Membrane proof | Room power levels | Pubkey list or open | DID list or open | Open (anyone can pin) | ACL (WAC) | Writer keys (Autobase) | Followers / allowlist / admin | Wallet WriteCap | Filesystem / Git host ACL |
| **Membership model** | Progenitor-controlled | `open` / `invite-only` | `open` / `pubkey-list` | `open` / `followers-only` / `list-only` | Open | `open` / `members-only` / `private` | Writer key management | `open` / `followers-only` / `members-only` / `admin-approved` | Capability-based | Out-of-band (Git host or shared filesystem) |
| **Rate limiting** | ❌ (DHT natural) | ✅ (client-side) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (per-actor) | ❌ | N/A (local) |

¹³ Nostr relay events and AT Proto repo records are publicly readable by default. Access control requires relay-level or PDS-level configuration, not the link language.

---

## Data Model & Storage

How links are represented in each protocol's native format.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|
| **Native format** | DHT entry (Action + Entry) | Custom room event | kind:30078 event (parameterized replaceable) | Repo record (`ad4m.link.triple`) | DAG-JSON object | RDF/Turtle resource | Feed block (JSON) | AP Activity (`Create{Note}`) | RDF Triple (SPARQL) | JSON file `links/<hash>.json` |
| **Storage location** | Holochain DHT | Homeserver DB | Relay DB | PDS repo | IPFS datastore | Pod filesystem | Hypercore feed | Inbox/Outbox | NextGraph wallet/store | Git working tree (executor data dir) |
| **Content-addressed** | ✅ (entry hash) | ❌ | ❌ (event ID = hash) | ❌ (rkey) | ✅ (CID) | ❌ | ❌ (seq number) | ❌ | ❌ | ✅ (hash filename) |
| **Append-only** | ✅ (DHT) | ❌ | Partial (replaceable events) | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ (CRDT) | ✅ (commit history) |
| **Merkle structure** | ✅ (DHT) | ❌ | ❌ | ✅ (MST) | ✅ (DAG) | ❌ | ✅ (Merkle tree) | ❌ | ✅ (DAG) | ✅ (Git commit DAG) |
| **Human-readable** | ❌ | ✅ (dual render) | ❌ (app data) | ❌ (structured record) | ❌ (DAG-JSON) | ✅ (RDF/Turtle) | ❌ | ✅ (Note content) | ❌ (SPARQL/RDF) | ✅ (JSON + `git log`) |
| **Native app visibility** | N/A | Element, other Matrix clients | Nostr clients (raw app data) | Bluesky (custom collection) | IPFS Gateway / Desktop | Penny, Mashlib, any Solid app | hyp CLI | Mastodon, Pleroma, Misskey | NextGraph apps | `git` CLI, GitHub / GitLab / Gitea web UIs |

---

## Scalability & Performance

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|
| **Sync latency** | ~1-10s (gossip) | ~1s (HTTP poll) | ~1s (WebSocket push) | ~1s (HTTP poll) | ~5-30s (DHT + IPNS) | ~1s (HTTP poll) | ~1-5s (DHT + gateway poll) | ~1-10s (HTTP delivery) | ~1-5s (CRDT propagation + gateway poll) | Local: milliseconds; remote: out-of-band |
| **Horizontal scaling** | ✅ (DHT shards) | ✅ (homeserver federation) | ✅ (relay multiplexing) | ✅ (PDS federation + relay) | ✅ (DHT) | Limited (single pod) | ✅ (Hyperswarm) | ✅ (server federation) | ✅ (CRDT mesh) | ✅ (any Git host) |
| **Max neighbourhood size** | DHT-limited (thousands) | Server-limited | Relay-limited | PDS-limited | DHT-limited | Server-limited | Feed-limited | Server-limited | CRDT-limited | Git-repo-limited ¹⁹ |
| **Bandwidth efficiency** | Gossip (efficient) | Polling (moderate) | Subscription (efficient) | Polling (moderate) | Polling (moderate) | Polling (moderate) | Polling (moderate) | Push delivery (efficient) | CRDT delta sync (efficient) | Pack files (very efficient) |

¹⁹ Practical ceilings follow standard Git advice — GitHub recommends keeping repos under ~1GB and under ~100K files. Render time grows linearly with link count until the snapshot cache lands ([git-link-language spec §11.6](https://github.com/coasys/git-link-language)).

---

## Protocol Interoperability

How each language relates to the broader protocol ecosystem.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|
| **Standards body** | Holochain Foundation | matrix.org Foundation | NIP process (community) | Bluesky PBC | IPFS / Protocol Labs | W3C Solid CG | Holepunch | W3C ActivityPub | NextGraph.org | Git project (Linus + maintainers) |
| **Spec maturity** | Stable | Stable | Evolving (NIPs) | Evolving | Stable | Stable | Stable | Stable (W3C Rec) | Alpha/Evolving | Stable (19+ years) |
| **Existing network size** | Small (Holochain apps) | Large (Matrix federation) | Large (Nostr relays) | Large (Bluesky + AT network) | Very large (IPFS network) | Small (Solid pods) | Small (Hypercore ecosystem) | Very large (Fediverse) | Small (NextGraph alpha) | Very large (every developer) |
| **AD4M links visible to native users** | Yes (Flux) | Yes (as room events) | Partial (raw app data) | Partial (custom collection) | Yes (via gateway) | Yes (as RDF resources) | Partial (via gateway) | Yes (as Notes) | Yes (as SPARQL triples) | Yes (JSON files + `git log`) |

---

## Summary: Choosing a Link Language

| If you need... | Use |
|---|---|
| Fully P2P, no infrastructure | **Holochain**, **Hypercore**, or **NextGraph** |
| Real-time telepresence (presence, signals) | **Holochain**, **Matrix**, **Nostr**, **IPFS**, or **Hypercore** |
| Human-readable data in native apps | **Matrix**, **Solid**, or **ActivityPub** |
| Sovereign identity (no server authority) | **Holochain**, **Nostr**, **IPFS**, **Hypercore**, or **NextGraph** |
| End-to-end encryption | **Matrix** (Olm/Megolm), **Hypercore** (symmetric key), or **NextGraph** (wallet-level) |
| Largest existing network reach | **ActivityPub** (Fediverse) or **Nostr** |
| W3C standards compliance | **Solid** (LDP + RDF) or **ActivityPub** (W3C Rec) |
| Content-addressed / immutable data | **IPFS** or **Holochain** |
| Easiest self-hosting | **Nostr** (single relay) or **Matrix** (Conduit) |
| Bridge to Bluesky / AT network | **AT Protocol** |
| Local-first / offline-capable | **NextGraph** (CRDT), **Git** (pure local), **Holochain** (partial), or **Hypercore** (partial) |
| Full audit trail + history queries | **Git** (commit DAG + `git-history` / `git-state-at` / `git-blame` queries) |
| Time-travel reads to past states | **Git** (`git-state-at` query) |
| Interoperability with existing developer tooling | **Git** (any Git CLI / GitHub / GitLab / Gitea) |
| Dual-language alongside Holochain | Any of the 8 ALDK languages (all support it) |

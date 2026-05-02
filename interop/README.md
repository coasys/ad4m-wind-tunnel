# AD4M Link Language Interop Tests

**Bidirectional data flow verification between AD4M/Flux and native protocol apps.**

Each test proves that AD4M link languages can:
1. **Write** links via AD4M → data appears in the native protocol's storage
2. **Read** data written by native protocol apps → links appear in AD4M

## Quick Start

```bash
# 1. Run setup (starts Docker services on Device A, checks executor)
./setup.sh

# 2. Run all verification tests
for f in verify-*.sh; do ./$f; echo ""; done

# 3. Clean up when done
./teardown.sh
```

## Prerequisites

### On your Mac (where you run the scripts)

- **Python 3** with `websockets` package:
  ```bash
  pip3 install websockets
  ```
- **jq**: `brew install jq`
- **curl**: built-in on macOS
- **nc** (netcat): built-in on macOS
- **SSH access** to Device A with key-based auth

### On Device A (YOUR_DEVICE_IP)

- **Docker** and **Docker Compose** v2
- **AD4M Executor** running on port 12000 with admin token `test123`
- **Node.js** (for Hypercore Gateway only)
- Network access from the Mac to Device A on ports:
  - 12000 (AD4M executor)
  - 6167 (Matrix/Conduit)
  - 2583 (AT Protocol/PDS)
  - 3000 (Solid/CSS)
  - 5001, 8080 (IPFS/Kubo)
  - 7777 (Nostr relay)
  - 7778 (Hypercore Gateway)

## Architecture

```
┌──────────────────────────┐     SSH / HTTP / WS     ┌──────────────────────────┐
│     Mac (test runner)    │ ◄──────────────────────► │   Device A (YOUR_DEVICE_IP) │
│                          │                          │                          │
│  verify-matrix.sh        │    WS :12000             │  AD4M Executor           │
│  verify-atproto.sh       │    HTTP :6167             │  ┌─ Matrix (Conduit)    │
│  verify-solid.sh         │    HTTP :2583             │  ├─ AT Proto (PDS)      │
│  verify-ipfs.sh          │    HTTP :3000             │  ├─ Solid (CSS)         │
│  verify-nostr.sh         │    HTTP :5001,:8080       │  ├─ IPFS (Kubo)         │
│  verify-hypercore.sh     │    WS  :7777             │  ├─ Nostr Relay          │
│                          │    HTTP :7778             │  └─ Hypercore Gateway   │
└──────────────────────────┘                          └──────────────────────────┘
```

All scripts run **from the Mac** and reach Device A over the network. Docker services run on Device A. The AD4M executor is on Device A at `ws://YOUR_DEVICE_IP:12000`.

## Test Flow (each verify-*.sh)

Every verification script follows the same 10-step pattern:

| Step | What                                      | How                                        |
|------|-------------------------------------------|--------------------------------------------|
| 1    | Health check                              | HTTP/WS probe to the backend service       |
| 2    | Test user/account setup                   | Create or login via native protocol API    |
| 3    | Apply language template                   | `language.applyTemplate` with service URLs |
| 4    | Create perspective → neighbourhood        | AD4M RPC to create perspective + publish   |
| 5    | Add 3 test links via AD4M                 | `perspective.addLink` × 3                  |
| 6    | Query links in AD4M                       | `perspective.queryLinks`                   |
| 7    | Query native service                      | Protocol-specific API call                 |
| 8    | Write data from native side               | Protocol-specific write                    |
| 9    | Trigger AD4M sync                         | `perspective.pullLinks`                    |
| 10   | Verify native data in AD4M                | `perspective.queryLinks` + check           |

## Protocol Details

### Matrix (Conduit)

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | Conduit (lightweight Matrix homeserver)     |
| Container       | `ad4m-interop-matrix`                       |
| Port            | 6167                                        |
| Language        | `QmzSYwdkxzhf4sCxuUH28xY6qCFb4xtEPxf4tSSrz8KNs3WUzAW` |
| Event type      | `dev.ad4m.link.triple` (custom room event) |
| Native app      | [Element Web](https://app.element.io) with custom homeserver |

**Interop proof:** AD4M writes links → custom events appear in Matrix room timeline → Element shows them. Custom event written via Matrix API → AD4M sync picks it up.

### AT Protocol (PDS)

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | Bluesky PDS (Personal Data Server)         |
| Container       | `ad4m-interop-atproto`                      |
| Port            | 2583                                        |
| Language        | `QmzSYwdgzU4pEnJUebu7yrZucqRGSaTfKJs7NBMuFcZLL28xqEq` |
| Collection      | `app.ad4m.link`                             |
| Native app      | curl to XRPC endpoints                     |

**Interop proof:** AD4M writes links → records appear in PDS repo under `app.ad4m.link` collection → `com.atproto.repo.listRecords` shows them. Record created via XRPC → AD4M sync picks it up.

> **Note:** Self-hosted PDS may reject custom Lexicons. The `app.ad4m.link` collection type may need to be registered with the PDS. See [AT Protocol Lexicon docs](https://atproto.com/specs/lexicon).

### Solid (CSS)

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | Community Solid Server                     |
| Container       | `ad4m-interop-solid`                        |
| Port            | 3000                                        |
| Language        | `QmzSYwdq6o6am1uXnDU7BJ9GFxVFs5xUJLqFQd3ewar7NvSFi8f` |
| Data format     | RDF/Turtle in LDP containers               |
| Native app      | [Penny](https://penny.vincenttunru.com/) or Mashlib |

**Interop proof:** AD4M writes links → Turtle resources appear in Solid pod container → browse in Penny. Turtle resource PUT to pod → AD4M sync picks it up.

### IPFS (Kubo)

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | Kubo (go-ipfs)                             |
| Container       | `ad4m-interop-ipfs`                         |
| Ports           | 5001 (API), 8080 (Gateway)                 |
| Language        | `QmzSYwdiVKeuFLdJSLNndi4Gpjegp1DATGrfyCphXxYYHd4gfRf` |
| Data format     | DAG-JSON objects                            |
| Native app      | IPFS Gateway or IPFS Desktop               |

**Interop proof:** AD4M writes links → DAG-JSON published to IPFS, fetchable via CID at gateway. DAG-JSON object added via API → AD4M reads CID.

### Nostr

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | nostr-rs-relay                             |
| Container       | `ad4m-interop-nostr`                        |
| Port            | 7777 (WebSocket)                           |
| Language        | `QmzSYwdoGhjYy5u7kQwRtv9GZy9U6y66GrdCWaEfk7zQDM3yMsW` |
| Event kind      | 30078 (parameterized replaceable — app data)|
| Native app      | [Snort](https://snort.social), [Iris](https://iris.to) |

**Interop proof:** AD4M writes links → kind:30078 events appear on relay → Nostr client shows app data. Event published via WebSocket → AD4M sync picks it up.

> **Note:** The Nostr language address will be updated after the native WebSocket fix is deployed.

### Hypercore

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | Custom Node.js gateway (NOT Docker)        |
| Port            | 7778                                        |
| Language        | `QmzSYwdpq92UgzvHHBAsHTC6jRHkBf7y74DaLmrAWnb8XUtnMVH` |
| Data format     | JSON entries in Hypercore feed             |
| Native app      | `hyp` CLI or custom Hypercore scripts      |

**Interop proof:** AD4M writes links → entries appended to Hypercore feed, visible via gateway API. Entry appended via gateway → AD4M sync picks it up.

> **Note:** The Hypercore language address will be updated after the gateway fix.

## Docker Compose

The `docker-compose.yml` defines 5 services (Hypercore is a standalone Node.js process):

```bash
# Start all Docker services
scp docker-compose.yml $USER@YOUR_DEVICE_IP:/tmp/ad4m-interop-compose.yml
ssh $USER@YOUR_DEVICE_IP "cd /tmp && docker compose -f ad4m-interop-compose.yml up -d"

# Check status
ssh $USER@YOUR_DEVICE_IP "docker compose -f /tmp/ad4m-interop-compose.yml ps"

# View logs
ssh $USER@YOUR_DEVICE_IP "docker compose -f /tmp/ad4m-interop-compose.yml logs -f matrix-conduit"

# Stop and remove
ssh $USER@YOUR_DEVICE_IP "cd /tmp && docker compose -f ad4m-interop-compose.yml down -v"
```

All services are on the `ad4m-interop` Docker network.

## Hypercore Gateway Setup

The Hypercore Gateway is a Node.js process, not a Docker container. To set it up:

```bash
# On Device A
ssh $USER@YOUR_DEVICE_IP
mkdir -p /tmp/hypercore-gateway
cd /tmp/hypercore-gateway
npm init -y
npm install hypercore hyperswarm express body-parser

# Create index.js — see the reference implementation in
# /tmp/ad4m-link-language-tests/scripts/languages/hypercore/
# Then start:
node index.js &
```

The gateway exposes:
- `GET /status` — health check
- `GET /feeds` — list feeds
- `POST /feeds` — create feed
- `GET /feeds/:key/entries` — list entries
- `POST /feeds/:key/append` — append entry

## Configuration

All scripts use defaults defined in `common.sh`:

| Variable       | Default                   | Description                   |
|----------------|---------------------------|-------------------------------|
| `DEVICE_A`     | `YOUR_DEVICE_IP`             | Device A IP                   |
| `DEVICE_A_USER`| `your-user`                    | SSH user for Device A         |
| `AD4M_HOST`    | `YOUR_DEVICE_IP`             | Executor host                 |
| `AD4M_PORT`    | `12000`                   | Executor port                 |
| `AD4M_TOKEN`   | `test123`                 | Executor admin token          |

Override via environment variables:
```bash
AD4M_HOST=192.168.1.100 AD4M_PORT=4000 ./verify-matrix.sh
```

## WS RPC Protocol

The AD4M executor uses WebSocket RPC at `ws://host:12000/api/v1/ws?token=<TOKEN>`.

Wire format:
```json
// Request
{"id": "abc123", "type": "operation.name", "params": {...}}

// Response  
{"id": "abc123", "result": ...}
```

Key operations used by these tests:
- `language.applyTemplate` — configure a language with service-specific params
- `perspective.create` — create a new perspective
- `neighbourhood.publish` — publish perspective as neighbourhood with link language
- `perspective.addLink` — add a link triple
- `perspective.queryLinks` — query links
- `perspective.pullLinks` — trigger sync
- `perspective.remove` — cleanup

The `ad4m-rpc.py` script wraps all operations as CLI commands.

## Troubleshooting

### Service not reachable
```bash
# Check if Docker service is running
ssh $USER@YOUR_DEVICE_IP "docker ps --filter 'name=ad4m-interop'"

# Check Docker logs
ssh $USER@YOUR_DEVICE_IP "docker logs ad4m-interop-matrix"

# Check port binding
ssh $USER@YOUR_DEVICE_IP "ss -tlnp | grep 6167"
```

### Executor not responding
```bash
# Check executor process
ssh $USER@YOUR_DEVICE_IP "ps aux | grep ad4m-executor"

# Test WebSocket directly
python3 -c "
import asyncio, websockets, json
async def test():
    async with websockets.connect('ws://YOUR_DEVICE_IP:12000/api/v1/ws?token=test123') as ws:
        await ws.send(json.dumps({'id':'1','type':'agent.status','params':{}}))
        print(await ws.recv())
asyncio.run(test())
"
```

### Language template fails
The language may not support the template parameters being passed. Check:
```bash
# Get language info including template params
python3 scripts/ad4m-rpc.py --host YOUR_DEVICE_IP --port 12000 --token test123 \
    language-get <LANGUAGE_ADDRESS>
```

### Port conflicts
If ports are already in use (e.g., Conduit already running on 6167), either:
1. Stop the existing service and use Docker Compose
2. Update `common.sh` to point at the existing service
3. Change ports in `docker-compose.yml`

## File Structure

```
interop/
├── README.md                 # This file
├── docker-compose.yml        # All backend services (5 containers)
├── common.sh                 # Shared helpers: RPC, colors, assertions
├── setup.sh                  # Deploy services + verify readiness
├── teardown.sh               # Clean up everything
├── verify-matrix.sh          # Matrix ↔ AD4M test
├── verify-atproto.sh         # AT Protocol ↔ AD4M test
├── verify-solid.sh           # Solid ↔ AD4M test
├── verify-ipfs.sh            # IPFS ↔ AD4M test
├── verify-nostr.sh           # Nostr ↔ AD4M test
└── verify-hypercore.sh       # Hypercore ↔ AD4M test
```

## Related

- Main test suite: `../scripts/common.sh` (multi-device sync tests)
- Infrastructure: `../infra/` (per-protocol Docker Compose files)
- RPC client: `../scripts/ad4m-rpc.py` (WebSocket RPC wrapper)
- Language source: `../scripts/languages/` (link language implementations)

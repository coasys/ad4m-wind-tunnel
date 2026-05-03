# Wind Tunnel Results: `feat/sparql-1.2-cleanup`

## Branch Highlights

The `feat/sparql-1.2-cleanup` branch replaces SurrealDB/Prolog with Oxigraph SPARQL for the perspective store.

### Strengths
- **Raw throughput king**: 1,023 ops/s at 25 concurrent clients (4x over dev)
- **Fastest single-op latency**: 0.45ms avg link add (vs 3.2ms dev)
- **Fastest cold start**: 14.4s total, perspective create in 15ms (vs 54ms dev)
- **Native SPARQL queries**: Sub-ms query times, fastest subject class seeding (19.3s vs 47.3s dev)
- **Flat query scaling**: 1.22x at 1K links (effectively flat)
- **Best concurrent perspective creation**: 50.6ms at batch-20 (vs 166ms dev)

### Weaknesses
- **Per-perspective memory cost**: 270MB RSS growth at 100 perspectives (Oxigraph stores are isolated per perspective)
- Higher idle RSS than WebSocket branch (544MB vs 208MB)
- Same memory growth rate as dev (2.4 MB/min)

### Key Metrics vs Dev
| Metric | dev | feat/sparql-1.2-cleanup | Improvement |
|--------|-----|------------------------|-------------|
| Concurrent throughput | 239 ops/s | 1,023 ops/s | **4.3x** |
| Link add latency | 3.2ms | 0.45ms | **7x faster** |
| Cold start | 15.8s | 14.4s | 9% faster |
| Perspective create | 54ms | 15ms | **3.6x faster** |
| Query scaling (1K) | 19.4x degradation | 1.22x (flat) | **Regression fixed** |
| Subject class seed (medium) | 47.3s | 19.3s | **2.4x faster** |
| MCP throughput | 2,381 calls/s | 2,632 calls/s | 10% faster |
| Perspective RSS (100) | 12MB growth | 270MB growth | ⚠️ Trade-off |

### Architecture Notes
- Each perspective gets its own Oxigraph Store (complete isolation)
- SPARQL 1.1 query support enables complex subject class patterns without Prolog
- Custom functions: `parse_literal`, `strip_html` registered as UDFs
- Trade-off: memory vs speed — the per-store approach gives zero cross-perspective interference but costs ~2.7MB per perspective
- **Potential optimisation**: shared Oxigraph store with named graphs per perspective could collapse the memory overhead

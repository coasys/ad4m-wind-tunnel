export { s1ColdStart } from "./s1-cold-start.js";
export { s2LinkThroughput } from "./s2-link-throughput.js";
export { s2bMillionLinks } from "./s2b-million-links.js";
export { s3PerspectiveScaling } from "./s3-perspective-scaling.js";
export { s4LanguageInstallStorm } from "./s4-language-install-storm.js";
export { s5QueryScaling } from "./s5-query-scaling.js";
export { s6ApiConcurrency } from "./s6-api-concurrency.js";
export { s7MemoryStability } from "./s7-memory-stability.js";
export { s8SubjectClassQueries } from "./s8-subject-class-queries.js";
export { m1NeighbourhoodSync } from "./m1-neighbourhood-sync.js";
export { m2MultiExecutorScale } from "./m2-multi-executor-scale.js";
export { m3LinkLanguageComparison } from "./m3-link-language-comparison.js";
export { m4WriteLoadUnderSync } from "./m4-write-load-under-sync.js";
export { m5ConcurrentNeighbourhoods } from "./m5-concurrent-neighbourhoods.js";
export { a1McpThroughput } from "./a1-mcp-throughput.js";
export { s9NeighbourhoodMemoryLeak } from "./s9-neighbourhood-memory-leak.js";
export { s10SubscriptionFanout } from "./s10-subscription-fanout.js";
export { s12PersistenceColdQuery } from "./s12-persistence-cold-query.js";
export { s13ReadWriteMix } from "./s13-read-write-mix.js";
export { s14MultiPerspectiveLoad } from "./s14-multi-perspective-load.js";
export { s15LeakAttribution } from "./s15-leak-attribution.js";

// ── WebRTC + SFU scenarios ──
//
// W* = WebRTC fundamentals (mesh path, also baselines for SFU)
// T* = SFU topology
// M* = Mid-call topology transitions (planned, see SFU plan)
// F* = Faults (planned)
// S* = Scale (planned)
//
// Pre-requisite: peer driver depends on `@roamhq/wrtc` (optional
// install).  SFU scenarios additionally need the executor compiled with
// the SFU service (always-on in the current architecture, no feature
// flag).
export { w1Mesh2Peer } from "./w1-mesh-2peer.js";
export { w1mMeshMultiMachine } from "./w1m-mesh-multimachine.js";
export { w2Mesh4Peer } from "./w2-mesh-4peer.js";
export { w3MeshRtt } from "./w3-mesh-rtt.js";
export { w4MeshBandwidthScaling } from "./w4-mesh-bandwidth-scaling.js";
export { w5TurnFallback } from "./w5-turn-fallback.js";
export { t1Sfu5Peer } from "./t1-sfu-5peer.js";
export { t2Sfu10Peer } from "./t2-sfu-10peer.js";
export { t5TopologyTable } from "./t5-topology-table.js";
export { t6PipeHandshake } from "./t6-pipe-handshake.js";
export { m1MeshToSfu } from "./m1-mesh-to-sfu.js";
export { m4SfuOfflineFallback } from "./m4-sfu-offline-fallback.js";
export { f5RenegotiationFlood } from "./f5-renegotiation-flood.js";
export { f6NonMemberJoin } from "./f6-non-member-join.js";
export { f7BadCapability } from "./f7-bad-capability.js";
export { s1Sfu20Peer } from "./s1-sfu-20peer.js";
export { f1MeshPacketLoss } from "./f1-mesh-packet-loss.js";
export { f2SfuPacketLoss } from "./f2-sfu-packet-loss.js";
export { f3OneWayNat } from "./f3-one-way-nat.js";
export { m2SfuToMesh } from "./m2-sfu-to-mesh.js";
export { t3SfuCascade2Node } from "./t3-sfu-cascade-2node.js";
export { t4SfuCascade3Node } from "./t4-sfu-cascade-3node.js";
export { m3CascadeFailover } from "./m3-cascade-failover.js";
export { f4NetworkPartition } from "./f4-network-partition.js";
export { s2SfuCascade4Node } from "./s2-sfu-cascade-4node.js";
export { s3MaxParticipantsEnforced } from "./s3-max-participants.js";

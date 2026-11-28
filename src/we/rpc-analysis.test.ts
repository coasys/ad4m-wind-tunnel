import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyse,
  callKind,
  errorGroups,
  eventStats,
  duplicateGroups,
  fanOutBursts,
  identicalWrites,
  percentile,
  phaseOf,
  phaseStats,
  pollingLoops,
  RpcCall,
  subscriptionFindings,
  wordCoverage,
} from "./rpc-analysis.js";

let seq = 0;
function call(p: Partial<RpcCall> & { method: string; start: number }): RpcCall {
  const durationMs = p.durationMs ?? 10;
  return {
    key: `k${seq++}`,
    channel: "ws",
    requestBytes: 100,
    responseBytes: 200,
    paramsHash: "p",
    paramsPreview: "{}",
    responseHash: "r",
    end: p.start + durationMs,
    durationMs,
    ...p,
  };
}

test("callKind infers read, write and subscribe from the method name", () => {
  assert.equal(callKind("perspective.modelQuery"), "read");
  assert.equal(callKind("perspective.queryLinks"), "read");
  assert.equal(callKind("perspective.linkStatus"), "read");
  assert.equal(callKind("ai.modelLoadingStatus"), "read");
  assert.equal(callKind("perspective.addLink"), "write");
  assert.equal(callKind("neighbourhood.sendBroadcastU"), "write");
  assert.equal(callKind("ai.transcriptionOpen"), "write");
  assert.equal(callKind("perspective.disposeQuerySubscription"), "write");
  assert.equal(callKind("perspective.keepAliveQuery"), "write", "a keep-alive refreshes a TTL; repeating it is its job");
  assert.equal(callKind("perspective.modelSubscribe"), "subscribe");
  assert.equal(callKind("perspective.addListener"), "subscribe");
  assert.equal(callKind("POST /api/v1/ai/transcription/feed"), "write");
});

test("percentile picks the nearest rank", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
});

test("identical reads with an unchanged answer are redundant", () => {
  const [g] = duplicateGroups(
    [
      call({ method: "perspective.all", start: 0, durationMs: 5 }),
      call({ method: "perspective.all", start: 100, durationMs: 7 }),
      call({ method: "perspective.all", start: 200, durationMs: 9 }),
    ],
    [],
  );
  assert.equal(g.calls, 3);
  assert.equal(g.unchangedRepeats, 2);
  assert.equal(g.wastedMs, 16);
  assert.equal(g.wastedBytes, 400);
  assert.equal(g.concurrentRepeats, 0);
  assert.equal(g.minIntervalMs, 100);
});

test("a read whose answer changed is not redundant, nor is one that failed", () => {
  const [g] = duplicateGroups(
    [
      call({ method: "ai.models", start: 0, responseHash: "a" }),
      call({ method: "ai.models", start: 100, responseHash: "b" }),
      call({ method: "ai.models", start: 200, responseHash: "b", error: "boom" }),
      call({ method: "ai.models", start: 300, responseHash: "b" }),
    ],
    [],
  );
  assert.equal(g.unchangedRepeats, 0);
});

test("identical calls overlapping in flight are coalescable", () => {
  const [g] = duplicateGroups(
    [
      call({ method: "agent.me", start: 0, durationMs: 100 }),
      call({ method: "agent.me", start: 20, durationMs: 100 }),
      call({ method: "agent.me", start: 50, durationMs: 10 }),
      call({ method: "agent.me", start: 500, durationMs: 10 }),
    ],
    [],
  );
  assert.equal(g.concurrentRepeats, 2);
});

test("writes are never counted as redundant reads", () => {
  const [g] = duplicateGroups(
    [call({ method: "perspective.addLink", start: 0 }), call({ method: "perspective.addLink", start: 50 })],
    [],
  );
  assert.equal(g.kind, "write");
  assert.equal(g.unchangedRepeats, 0);
  assert.deepEqual(identicalWrites([g]).map((x) => x.method), ["perspective.addLink"]);
});

test("distinct answers tell repeated creates from double submits", () => {
  const [batches] = duplicateGroups(
    [0, 20, 40].map((start, i) => call({ method: "perspective.createBatch", start, responseHash: `batch${i}` })),
    [],
  );
  assert.equal(batches.distinctAnswers, 3);
  const [resubmit] = duplicateGroups(
    [0, 20].map((start) => call({ method: "perspective.executeCommands", start, responseHash: "ok" })),
    [],
  );
  assert.equal(resubmit.distinctAnswers, 1);
});

test("failed calls are grouped by method and message", () => {
  const phases = [{ name: "create-space", start: 0, end: 1000 }];
  const groups = errorGroups(
    [
      call({ method: "neighbourhood.sendBroadcast", start: 1, error: "no link language" }),
      call({ method: "neighbourhood.sendBroadcast", start: 2, error: "no link language", callSite: "a.ts:1" }),
      call({ method: "neighbourhood.otherAgents", start: 3, error: "no link language" }),
      call({ method: "agent.me", start: 4 }),
    ],
    phases,
  );
  assert.deepEqual(
    groups.map((g) => [g.method, g.calls, g.callSites, g.phases]),
    [
      ["neighbourhood.sendBroadcast", 2, ["a.ts:1"], ["create-space"]],
      ["neighbourhood.otherAgents", 1, [], ["create-space"]],
    ],
  );
});

test("different params are different groups; singletons are dropped", () => {
  const groups = duplicateGroups(
    [
      call({ method: "perspective.modelQuery", start: 0, paramsHash: "a" }),
      call({ method: "perspective.modelQuery", start: 1, paramsHash: "b" }),
    ],
    [],
  );
  assert.equal(groups.length, 0);
});

test("a regular slow repeat is a polling loop; an irregular or fast one is not", () => {
  const regular = [0, 3000, 6050, 9000, 12020].map((start) => call({ method: "ai.modelLoadingStatus", start }));
  const irregular = [0, 300, 5000, 5400, 20000].map((start) =>
    call({ method: "agent.status", start, paramsHash: "x" }),
  );
  const fast = [0, 100, 200, 300, 400].map((start) => call({ method: "agent.me", start, paramsHash: "y" }));
  const loops = pollingLoops(duplicateGroups([...regular, ...irregular, ...fast], []));
  assert.equal(loops.length, 1);
  assert.equal(loops[0].method, "ai.modelLoadingStatus");
  assert.ok(Math.abs(loops[0].periodMs - 3000) <= 50);
  assert.equal(loops[0].unchangedRatio, 1);
});

test("periodic identical writes are polling, not double submits", () => {
  const heartbeat = [0, 5000, 10000, 15000, 20000].map((start) =>
    call({ method: "neighbourhood.setOnlineStatus", start }),
  );
  assert.equal(identicalWrites(duplicateGroups(heartbeat, [])).length, 0);
});

test("many calls of one method with varying params in a tight window are a fan-out burst", () => {
  const burst = [0, 10, 20, 30, 40, 50].map((start, i) =>
    call({
      method: "perspective.modelQuery",
      start,
      paramsHash: `h${i}`,
      paramsPreview: `{"id":${i}}`,
      paramDigest: { uuid: "same", id: `id${i}` },
    }),
  );
  const later = call({ method: "perspective.modelQuery", start: 5000, paramsHash: "h9" });
  const same = [0, 1, 2, 3, 4, 5].map((start) => call({ method: "agent.me", start }));
  const bursts = fanOutBursts([...burst, later, ...same], [{ name: "boot", start: 0, end: 10000 }]);
  assert.equal(bursts.length, 1);
  assert.equal(bursts[0].calls, 6);
  assert.equal(bursts[0].distinctParams, 6);
  assert.equal(bursts[0].windowMs, 50);
  assert.deepEqual(bursts[0].varyingKeys, ["id"]);
  assert.equal(bursts[0].phase, "boot");
  assert.equal(bursts[0].samples.length, 3);
});

test("subscription findings count unchanged pushes and duplicate live subscriptions", () => {
  const sub = { query: "q", perspectiveUUID: "p", modelName: "TextBlock", updateCount: 3, fingerprintHits: 2, fingerprintMisses: 1, active: true };
  const f = subscriptionFindings([sub, { ...sub }, { ...sub, active: false }, { ...sub, modelName: "Space" }]);
  assert.equal(f.total, 4);
  assert.equal(f.activeAtEnd, 3);
  assert.equal(f.updates, 12);
  assert.equal(f.unchangedUpdates, 8);
  assert.deepEqual(f.duplicateActive, [{ modelName: "TextBlock", perspectiveUUID: "p", query: "q", active: 2 }]);
});

test("calls and events are bucketed into the phase they started in", () => {
  const phases = [
    { name: "boot", start: 0, end: 100 },
    { name: "call", start: 100, end: 200 },
  ];
  assert.equal(phaseOf(-5, phases), "boot");
  assert.equal(phaseOf(100, phases), "call");
  assert.equal(phaseOf(500, phases), "call");
  const gapped = [
    { name: "boot", start: 0, end: 100 },
    { name: "call", start: 150, end: 200 },
  ];
  assert.equal(phaseOf(120, gapped), "boot", "a call between phases belongs to the one that just ended");
  const stats = phaseStats(
    [call({ method: "a", start: 10 }), call({ method: "b", start: 150 }), call({ method: "b", start: 160 })],
    [{ type: "transcription-text", at: 170, bytes: 50 }],
    phases,
  );
  assert.deepEqual(
    stats.map((s) => [s.name, s.calls, s.methods, s.events, s.eventBytes]),
    [
      ["boot", 1, 1, 0, 0],
      ["call", 2, 1, 1, 50],
    ],
  );
});

test("analyse totals redundancy across groups", () => {
  const calls = [
    call({ method: "perspective.all", start: 0, durationMs: 50 }),
    call({ method: "perspective.all", start: 10, durationMs: 50 }),
    call({ method: "perspective.all", start: 200, durationMs: 50 }),
    call({ method: "POST /api/v1/ai/transcription/feed", start: 300, channel: "http", paramsHash: "f1" }),
  ];
  const a = analyse({ calls, events: [], phases: [{ name: "run", start: 0, end: 1000 }], subscriptions: [] });
  assert.equal(a.totals.calls, 4);
  assert.equal(a.totals.httpCalls, 1);
  assert.equal(a.totals.redundantReads, 2);
  assert.equal(a.totals.coalescable, 1);
  assert.equal(a.slowest[0].method, "perspective.all");
});

test("wordCoverage ignores case and punctuation", () => {
  const expected = "If you can read this, transcription is working.";
  assert.equal(wordCoverage(expected, " if you can read this transcription is working"), 1);
  assert.equal(wordCoverage(expected, "Transcription working!"), 2 / 8);
  assert.equal(wordCoverage("", "anything"), 1);
});

test("the same push message twice within a second is a duplicate delivery", () => {
  const stats = eventStats(
    [
      { type: "transcription-text", at: 0, bytes: 90, hash: "a", socket: 1 },
      { type: "transcription-text", at: 3, bytes: 90, hash: "a", socket: 1 },
      { type: "transcription-text", at: 5000, bytes: 90, hash: "a", socket: 1 },
      { type: "link-added", at: 10, bytes: 800, hash: "b", socket: 1 },
      { type: "link-added", at: 11, bytes: 800, hash: "b", socket: 2 },
      { type: "link-added", at: 20, bytes: 800, hash: "c", socket: 1 },
      { type: "pong", at: 0, bytes: 20 },
      { type: "pong", at: 1, bytes: 20 },
    ],
    10000,
  );
  const byType = Object.fromEntries(stats.map((t) => [t.type, t]));
  assert.equal(byType["transcription-text"].count, 3);
  assert.equal(byType["transcription-text"].duplicates, 1);
  assert.equal(byType["transcription-text"].duplicateBytes, 90);
  assert.equal(byType["transcription-text"].crossSocketDuplicates, 0);
  assert.equal(byType["link-added"].duplicates, 1);
  assert.equal(byType["link-added"].crossSocketDuplicates, 1, "the copy came on another socket");
  assert.equal(byType["pong"].duplicates, 0, "events without a hash are never compared");
});

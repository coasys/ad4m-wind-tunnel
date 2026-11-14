import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FaultSample, Phase, percentile, slope, backlog, classifyPileup, recoveryTime, countLogLine, emptyLogCounts,
  splitLines, quotaPercentForSlowdown, parseLevels, orphanSubs,
} from "./analysis.js";
import { parseCpuStat, scopeLauncher, scopeUnitName } from "./cgroup.js";
import { reopenDelay, liveLineIds } from "./live-client.js";
import { feedQuery, everythingQuery, seedLinks } from "../scenarios/f1-slow-executor.js";

function sample(tMs: number, phase: Phase, over: Partial<FaultSample> = {}): FaultSample {
  return {
    tMs, phase, cpuPercent: 50, rssKb: 100_000, threads: 100, evalThreads: 0, executorSubs: 21,
    clientLiveSubs: 21, clientInflight: 1, timeouts: 0, resubscribes: 0, throttledMs: 0, ...over,
  };
}

/** 60 s baseline, 120 s fault, 120 s recovery; `fault`/`recovery` override per second. */
function run(fault: (i: number) => Partial<FaultSample>, recovery: (i: number) => Partial<FaultSample> = () => ({})): FaultSample[] {
  const out: FaultSample[] = [];
  for (let i = 0; i < 60; i++) out.push(sample(i * 1000, "baseline"));
  for (let i = 0; i < 120; i++) out.push(sample((60 + i) * 1000, "fault", fault(i)));
  for (let i = 0; i < 120; i++) out.push(sample((180 + i) * 1000, "recovery", recovery(i)));
  return out;
}

test("percentile is nearest-rank and ignores non-finite values", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4], 0.99), 4);
  assert.equal(percentile([1, NaN, 2], 0), 1);
  assert.ok(Number.isNaN(percentile([], 0.5)));
});

test("slope fits a least-squares line", () => {
  assert.equal(slope([0, 1, 2, 3], [1, 3, 5, 7]), 2);
  assert.equal(slope([1], [1]), 0);
  assert.equal(slope([2, 2], [1, 5]), 0);
});

test("backlog counts evals, in-flight calls and orphaned subscriptions only", () => {
  assert.equal(backlog(sample(0, "fault", { evalThreads: 3, clientInflight: 4, executorSubs: 30, clientLiveSubs: 21 })), 16);
  // More client subs than the log shows (a subscribe without a log line): no negative orphans.
  assert.equal(backlog(sample(0, "fault", { evalThreads: 0, clientInflight: 0, executorSubs: 10, clientLiveSubs: 21 })), 0);
});

test("classifyPileup: backlog growing to the end of the fault is a pileup", () => {
  const v = classifyPileup(run((i) => ({ clientInflight: 1 + Math.floor(i / 4), evalThreads: 8 })));
  assert.equal(v.pileup, true, v.reason);
  assert.ok(v.growthPerMin > 10);
  assert.equal(v.baselineBacklog, 1);
});

test("classifyPileup: high but flat backlog is saturation, not a pileup", () => {
  const v = classifyPileup(run((i) => ({ clientInflight: i < 10 ? 1 + i * 3 : 30 })));
  assert.equal(v.pileup, false);
  assert.match(v.reason, /saturated, bounded/);
});

test("classifyPileup: no change stays at baseline, and no fault samples is not a pileup", () => {
  const v = classifyPileup(run(() => ({})));
  assert.equal(v.pileup, false);
  assert.match(v.reason, /near baseline/);
  assert.equal(classifyPileup([sample(0, "baseline")]).reason, "no fault samples");
});

test("recoveryTime: first of 10 calm samples after the fault", () => {
  const s = run(() => ({ cpuPercent: 100, clientInflight: 40 }), (i) => (i < 15 ? { cpuPercent: 900, clientInflight: 40 } : {}));
  const r = recoveryTime(s);
  assert.equal(r.recovered, true);
  // fault ends at t=179 s; the first calm sample is t=195 s.
  assert.equal(r.recoveryMs, 16_000);
  assert.equal(r.thresholds.cpuPercent, 100);
  assert.equal(r.thresholds.backlog, 3);
  assert.equal(r.thresholds.orphanSubs, 2);
});

test("recoveryTime: orphaned executor subscriptions that never drain mean no recovery", () => {
  const r = recoveryTime(run(() => ({ executorSubs: 60 }), () => ({ executorSubs: 60 })));
  assert.equal(r.recovered, false);
  assert.equal(r.recoveryMs, null);
});

test("recoveryTime: subscribes the client cancelled do not count as orphans", () => {
  // 20 timed-out subscribes: logged as created, removed silently on cancel.
  const r = recoveryTime(run(() => ({ executorSubs: 41, subCancels: 20 }), () => ({ executorSubs: 41, subCancels: 20 })));
  assert.equal(r.recovered, true);
  assert.equal(orphanSubs(sample(0, "recovery", { executorSubs: 41, subCancels: 20, clientLiveSubs: 21 })), 0);
  assert.equal(orphanSubs(sample(0, "recovery", { executorSubs: 41, clientLiveSubs: 21 })), 20);
});

test("recoveryTime: a calm run must be unbroken", () => {
  const r = recoveryTime(run(() => ({}), (i) => (i % 9 === 8 ? { cpuPercent: 1000 } : {})));
  assert.equal(r.recovered, false);
});

test("countLogLine counts created, dropped and deadline stops", () => {
  const c = emptyLogCounts();
  countLogLine("2026-11-14 INFO 🔗 subscription 1b2c created for connection 7 [abcd-1234]", c);
  countLogLine("🔗 subscription x created for connection 8 [abcd]", c);
  countLogLine("🔗 3 subscription(s) dropped [abcd-1234]", c);
  countLogLine("WARN SPARQL query deadline of 30s passed; stopping evaluation", c);
  countLogLine("unrelated line", c);
  assert.deepEqual(c, { created: 2, dropped: 3, deadlineStops: 1 });
});

test("splitLines keeps the unfinished tail", () => {
  let r = splitLines("", "a\nb\nc");
  assert.deepEqual(r, { lines: ["a", "b"], carry: "c" });
  r = splitLines(r.carry, "d\n");
  assert.deepEqual(r, { lines: ["cd"], carry: "" });
});

test("quotaPercentForSlowdown gives 1/N of one core, none at 1×", () => {
  assert.equal(quotaPercentForSlowdown(1), null);
  assert.equal(quotaPercentForSlowdown(0.5), null);
  assert.equal(quotaPercentForSlowdown(4), 25);
  assert.equal(quotaPercentForSlowdown(20), 5);
  assert.equal(quotaPercentForSlowdown(100), 1);
  assert.equal(quotaPercentForSlowdown(1000), 1);
});

test("parseLevels", () => {
  assert.deepEqual(parseLevels(undefined, [1, 4]), [1, 4]);
  assert.deepEqual(parseLevels("1, 20,100", []), [1, 20, 100]);
  assert.throws(() => parseLevels("1,x", []));
  assert.throws(() => parseLevels("0.5", []));
});

test("parseCpuStat reads cgroup v2 cpu.stat", () => {
  const s = parseCpuStat("usage_usec 1234\nuser_usec 1000\nsystem_usec 234\nnr_periods 50\nnr_throttled 7\nthrottled_usec 9999\n");
  assert.deepEqual(s, { usageUsec: 1234, nrPeriods: 50, nrThrottled: 7, throttledUsec: 9999 });
  assert.deepEqual(parseCpuStat(""), { usageUsec: 0, nrPeriods: 0, nrThrottled: 0, throttledUsec: 0 });
});

test("scopeLauncher builds an exec-in-place systemd-run prefix", () => {
  assert.deepEqual(scopeLauncher("u1"), ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--unit=u1", "--"]);
  const withMem = scopeLauncher("u2", "8G");
  assert.deepEqual(withMem.slice(-5), ["-p", "MemoryMax=8G", "-p", "MemorySwapMax=0", "--"]);
  assert.match(scopeUnitName("l4 x/y"), /^hex-wt-f1exec-l4-x-y-\d+$/);
});

test("reopenDelay matches the SDK backoff: half to full of a doubling ceiling, capped", () => {
  assert.equal(reopenDelay(1, () => 0), 500);
  assert.equal(reopenDelay(1, () => 1), 1000);
  assert.equal(reopenDelay(3, () => 1), 4000);
  assert.equal(reopenDelay(20, () => 1), 60_000);
  assert.equal(reopenDelay(0, () => 0), 500);
});

test("liveLineIds finds written line ids in any result shape", () => {
  assert.deepEqual(liveLineIds([{ item: "ad4m://wt/f1/line/live-12" }, { item: "ad4m://wt/f1/line/seed-3" }]), [12]);
  assert.deepEqual(liveLineIds("x /line/live-1 y /line/live-22"), [1, 22]);
  assert.deepEqual(liveLineIds(null), []);
});

test("f1 queries and seed data have the WE shape", () => {
  const q = feedQuery("ad4m://c", 50, 100);
  assert.match(q, /<<\( <ad4m:\/\/c> <ad4m:\/\/has_child> \?item \)>>/);
  assert.match(q, /ORDER BY DESC\(\?ts\) LIMIT 50 OFFSET 100$/);
  assert.doesNotMatch(feedQuery("ad4m://c", 50), /OFFSET/);
  assert.match(everythingQuery("links"), /<<\( \?s \?p \?o \)>>/);
  assert.equal(everythingQuery("all"), "SELECT ?s ?p ?o WHERE { ?s ?p ?o }");
  const links = seedLinks(30000);
  assert.ok(links.length <= 30000 && links.length >= 29998);
  assert.equal(links.filter((l) => l.source === "ad4m://wt/f1/channel").length, 10000);
  assert.equal(links.filter((l) => l.source === "ad4m://wt/f1/call").length, 5000);
});

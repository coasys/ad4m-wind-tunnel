/**
 * Unit tests for the harness pieces the platform baseline depends on.
 * Run: npm test   (node --test through tsx; no executor needed)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { stats, mdTable, envIntList, perspectiveStoreSizes, totalStoreSize, measureIdleWindow, linkServerReachable, skippedResult, untilFound, timedEach } from "./common.js";
import {
  threadPool, threadGroups, procStatus, descendantPids, ticksToPercent, dirSizeBytes, loadAverage, hostCpuSnapshot,
} from "../proc-metrics.js";
import { WebSocketServer } from "ws";
import { stopExecutorAndWait, waitForHealth } from "../executor.js";
import { parseBool, resolveConfig } from "../config.js";
import { markdownReport } from "../reporters.js";
import { summarize, headlines } from "./summarize.js";

test("stats: mean, median, sample stddev, min, max", () => {
  const s = stats([1, 2, 3, 4]);
  assert.equal(s.n, 4);
  assert.equal(s.mean, 2.5);
  assert.equal(s.median, 2.5);
  assert.equal(s.min, 1);
  assert.equal(s.max, 4);
  assert.ok(Math.abs(s.stddev - 1.2909944) < 1e-6);
  assert.equal(stats([]).n, 0);
  assert.equal(stats([NaN, 5]).mean, 5);
});

test("threadPool collapses numbered thread names into one pool", () => {
  assert.equal(threadPool("tokio-runtime-w"), "tokio-runtime-w");
  assert.equal(threadPool("worker-12"), "worker");
  assert.equal(threadPool("rayon#3"), "rayon");
  assert.equal(threadPool("V8 DefaultWorke"), "V8 DefaultWorke");
  assert.equal(threadPool("42"), "42");
  assert.equal(threadPool("lang-QmzSYwdb"), "lang-*");
  assert.equal(threadPool("lang-Qm1234"), "lang-*");
});

test("ticksToPercent: 100 ticks in 1 s is one full core", () => {
  assert.equal(ticksToPercent(100, 1000), 100);
  assert.equal(ticksToPercent(5, 1000), 5);
  assert.equal(ticksToPercent(10, 0), 0);
});

test("procStatus, threadGroups and descendantPids read a live process tree", async () => {
  const child = spawn("sh", ["-c", "sleep 30 & wait"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const st = procStatus(child.pid!);
    assert.ok(st && st.vmRssKb! > 0 && st.threads! >= 1);
    const kids = descendantPids(child.pid!);
    assert.equal(kids.length, 1, "sh has one sleep child");
    const own = threadGroups(process.pid);
    assert.ok(own.reduce((a, g) => a + g.count, 0) >= 1);
  } finally {
    child.kill("SIGKILL");
  }
  assert.equal(procStatus(999999999), null);
});

test("host counters are readable", () => {
  assert.equal(loadAverage()?.length, 3);
  const h = hostCpuSnapshot();
  assert.ok(h && h.total >= h.busy && h.busy > 0);
});

test("dirSizeBytes sums files and does not follow symlinks; perspectiveStoreSizes keys by uuid", () => {
  const d = mkdtempSync(join(tmpdir(), "wt-test-"));
  try {
    mkdirSync(join(d, "perspectives", "uuid-a", "sub"), { recursive: true });
    writeFileSync(join(d, "perspectives", "uuid-a", "x"), Buffer.alloc(1000));
    writeFileSync(join(d, "perspectives", "uuid-a", "sub", "y"), Buffer.alloc(24));
    symlinkSync("/usr", join(d, "perspectives", "uuid-a", "link"));
    assert.equal(dirSizeBytes(join(d, "perspectives", "uuid-a")), 1024);
    assert.deepEqual(perspectiveStoreSizes(d), { "uuid-a": { bytes: 1024, walBytes: 0 } });
    assert.deepEqual(perspectiveStoreSizes(join(d, "missing")), {});
    // RocksDB WAL segments are `<n>.log`; the info log `LOG` is not WAL.
    mkdirSync(join(d, "perspectives", "uuid-b", "sparql_store"), { recursive: true });
    writeFileSync(join(d, "perspectives", "uuid-b", "sparql_store", "000034.log"), Buffer.alloc(300));
    writeFileSync(join(d, "perspectives", "uuid-b", "sparql_store", "LOG"), Buffer.alloc(50));
    writeFileSync(join(d, "perspectives", "uuid-b", "sparql_store", "000010.sst"), Buffer.alloc(100));
    assert.deepEqual(perspectiveStoreSizes(d)["uuid-b"], { bytes: 450, walBytes: 300 });
    assert.deepEqual(totalStoreSize(d), { bytes: 1474, walBytes: 300 });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("stopExecutorAndWait escalates to SIGKILL when SIGTERM is ignored", async () => {
  // The old stopExecutor checked `proc.killed`, which is true right after
  // SIGTERM is sent, so SIGKILL never fired and the process lived on.
  const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 0.1; done"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  await stopExecutorAndWait(child, 500);
  assert.ok(child.exitCode !== null || child.signalCode !== null, "process exited");
  assert.equal(child.signalCode, "SIGKILL");
  assert.ok(Date.now() - t0 < 5000);
  await stopExecutorAndWait(child); // already gone: returns at once
});

test("measureIdleWindow returns the window, samples and per-pool CPU", async () => {
  const child = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 200));
    const w = await measureIdleWindow(child.pid!, { settleSec: 0, windowSec: 1, sampleSec: 0.25 });
    assert.ok(w.samples.length >= 3);
    assert.ok(w.cpuPercent >= 0 && w.cpuPercent < 50);
    assert.ok(w.rssKb.end > 0);
    assert.equal(w.threads.end, 1);
    assert.ok(w.cpuByPool.length >= 1);
    assert.ok(w.loadAvgBefore && w.loadAvgAfter);
  } finally {
    child.kill("SIGKILL");
  }
});

test("linkServerReachable: up answers ok, down is reported, not thrown", async () => {
  const srv = createServer((req, res) => {
    res.statusCode = req.url === "/health" ? 200 : 404;
    res.end("ok");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  try {
    assert.equal((await linkServerReachable(`http://127.0.0.1:${port}`)).ok, true);
  } finally {
    srv.close();
  }
  const down = await linkServerReachable(`http://127.0.0.1:${port}`);
  assert.equal(down.ok, false);
  assert.ok(down.detail.length > 0);
});

test("waitForHealth resolution follows pollMs (boot time is not quantised to 500 ms)", async () => {
  let ready = false;
  const srv = createServer((req, res) => {
    res.statusCode = ready && req.url === "/health" ? 200 : 503;
    res.end();
  });
  const wss = new WebSocketServer({ server: srv });
  wss.on("connection", (ws) => ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    ws.send(JSON.stringify({ id: m.id, result: {} }));
  }));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  try {
    setTimeout(() => { ready = true; }, 120);
    const ms = await waitForHealth(port, 5000, "t", 20);
    assert.ok(ms >= 100 && ms < 400, `took ${ms} ms`);
  } finally {
    wss.close();
    srv.close();
  }
});

test("skippedResult is marked skipped and not passed", () => {
  const r = skippedResult("p2-neighbourhoods", "Space Cost Neighbourhoods", { branch: "b" } as any, Date.now(), "down", { n: 1 });
  assert.equal(r.skipped, true);
  assert.equal(r.passed, false);
  assert.equal(r.scenario, "p2-neighbourhoods-space-cost-neighbourhoods");
  assert.match(r.markdown!, /Skipped/);
});

test("config: --repeat NaN falls back to 1, --run-holochain parses, CLI beats env", () => {
  assert.equal(resolveConfig(["--repeat", "abc"], {}).repeat, 1);
  assert.equal(resolveConfig([], { AD4M_WT_REPEAT: "x" }).repeat, 1);
  assert.equal(resolveConfig(["--repeat", "3"], { AD4M_WT_REPEAT: "5" }).repeat, 3);
  assert.equal(resolveConfig([], {}).runHolochain, true);
  assert.equal(resolveConfig(["--run-holochain", "false"], { AD4M_WT_RUN_HOLOCHAIN: "true" }).runHolochain, false);
  assert.equal(resolveConfig([], { AD4M_WT_RUN_HOLOCHAIN: "off" }).runHolochain, false);
  assert.equal(resolveConfig(["--link-server-url", "http://x:1"], { LINK_SERVER_URL: "http://y:2" }).linkServerUrl, "http://x:1");
  assert.equal(parseBool(undefined), undefined);
  assert.throws(() => parseBool("maybe"));
});

test("summarize groups runs per label and scenario and reports the spread", () => {
  const d = mkdtempSync(join(tmpdir(), "wt-sum-"));
  try {
    mkdirSync(join(d, "x-hc-off"));
    mkdirSync(join(d, "logs"));
    const run = (cpu: number, rss: number, i: number) => ({
      scenario: `p1-platform-idle-baseline-run${i}`, branch: "x-hc-off", startTime: 0, endTime: 1, durationMs: 1, passed: true,
      metrics: { cpuPercent: cpu, rssMb: rss, threads: 70, idleWindow: { end: { threadGroups: [{ pool: "tokio-rt-worker", count: 32 }] }, cpuByPool: [] } },
      samples: [], summary: "",
    });
    writeFileSync(join(d, "x-hc-off", "p1-platform-idle-baseline-run1.json"), JSON.stringify(run(1, 200, 1)));
    writeFileSync(join(d, "x-hc-off", "p1-platform-idle-baseline-run2.json"), JSON.stringify(run(3, 210, 2)));
    writeFileSync(join(d, "x-hc-off", "s1-cold-start.json"), JSON.stringify(run(9, 9, 3)));
    const { markdown, json } = summarize(d) as { markdown: string; json: any[] };
    assert.equal(json.length, 1);
    assert.equal(json[0].runs, 2);
    const cpu = json[0].metrics.find((m: any) => m.metric.startsWith("CPU %"));
    assert.equal(cpu.mean, 2);
    assert.equal(cpu.min, 1);
    assert.equal(cpu.max, 3);
    assert.ok(json[0].metrics.some((m: any) => m.metric === "Threads in pool tokio-rt-worker" && m.mean === 32));
    assert.match(markdown, /## p1 — x-hc-off/);
    assert.deepEqual(headlines("p2-perspectives", { skipped: true }), {});
    // P3 reports the first restart after writes apart from the two query modes;
    // older results without it still summarise.
    const mode = (rss: number) => ({ bootMs: 1, rssAfterSettleMb: rss, perQuery: { max: 2 } });
    const p3 = headlines("p3", { manySpaces: { storeTotalMb: 85, walTotalMb: 80, afterWrites: mode(680), sequential: mode(345), concurrent: mode(345) } });
    assert.equal(p3["spaces afterWrites: RSS after settle MB"], 680);
    assert.equal(p3["spaces sequential: RSS after settle MB"], 345);
    assert.equal(p3["spaces: WAL MB total"], 80);
    const old = headlines("p3", { manySpaces: { storeTotalMb: 85, sequential: mode(678), concurrent: mode(345) } });
    assert.equal(old["spaces afterWrites: RSS after settle MB"], undefined);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("envIntList parses and rejects bad lists", () => {
  process.env.WT_TEST_LIST = "1, 5,20";
  assert.deepEqual(envIntList("WT_TEST_LIST", [9]), [1, 5, 20]);
  process.env.WT_TEST_LIST = "1,x";
  assert.throws(() => envIntList("WT_TEST_LIST", [9]));
  delete process.env.WT_TEST_LIST;
  assert.deepEqual(envIntList("WT_TEST_LIST", [9]), [9]);
});

test("markdown: tables and the report fallback for a result with no markdown", () => {
  assert.equal(mdTable(["a", "b"], [[1.234, "x"], [NaN, "y"]]), "| a | b |\n| --- | --- |\n| 1.23 | x |\n| — | y |");
  const md = markdownReport({
    scenario: "x", branch: "b", startTime: 0, endTime: 1, durationMs: 1, passed: true,
    metrics: { rssMb: 12, nested: { a: 1 } }, samples: [], summary: "sum",
  });
  assert.match(md, /rssMb/);
  assert.match(md, /sum/);
});

test("untilFound waits through 'Perspective not found' and rethrows other errors", async () => {
  // P3 crashed: the executor answers /health before its stored perspectives are
  // open, so the first query after a restart got a 404 for a perspective that exists.
  let calls = 0;
  const r = await untilFound(async () => {
    if (++calls < 4) throw new Error("Perspective d2920da8-57a1 not found");
    return "links";
  }, 5000, 1);
  assert.equal(r.value, "links");
  assert.equal(r.notFoundAnswers, 3);
  assert.ok(r.totalMs >= 0);

  await assert.rejects(untilFound(async () => { throw new Error("queryLinks failed: bad params"); }, 5000, 1), /bad params/);
  await assert.rejects(untilFound(async () => { throw new Error("Perspective x not found"); }, 30, 5), /not found/);
});

test("timedEach times only the calls and collects thrown and returned errors", async () => {
  const r = await timedEach([1, 2, 3, 4], async (n) => {
    await new Promise((res) => setTimeout(res, 20));
    if (n === 2) throw new Error("boom");
    if (n === 3) return { error: "refused" };
    return { ok: true };
  }, (n) => `item${n}`);
  assert.deepEqual(r.errors, ["item2: boom", "item3: refused"]);
  assert.ok(r.ms >= 70 && r.ms < 1000, `took ${r.ms} ms`);
  // The elapsed time is fixed when timedEach returns: a later wait does not change it.
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(r.ms < 1000);
});

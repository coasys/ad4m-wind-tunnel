import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRuns, summaryRow, sortRows, summaryMarkdown, StoreCloseRun, MemSample } from "./store-close-summary.js";

const mem = (rss: number, hwm = rss): MemSample => ({ rss_mib: rss, anon_mib: rss - 10, file_mib: 10, hwm_mib: hwm, threads: 40 });

function run(over: Partial<StoreCloseRun> & { flushSample?: boolean; purge?: boolean } = {}): StoreCloseRun {
  const samples: Record<string, MemSample> = {
    start: mem(10),
    opened: mem(200),
    written: mem(1010, 1100),
    closed: mem(900),
    closed_settled: mem(880),
    closed_trimmed: mem(510),
    reopened: mem(300),
    reopened_counted: mem(320),
    reclosed_trimmed: mem(500),
  };
  if (over.flushSample) samples.flushed = mem(1110, 1200);
  if (over.purge) samples.closed_purged = mem(110);
  return {
    label: "x", n: 50, m: 1000, flush: !!over.flushSample, quads: 400000, quads_after_reopen: 400000, disk_mib: 123.45,
    wal_mib: 0, times: { open_s: 1, write_s: 20, close_s: 0.5, reopen_s: 2.5, reopen_count_s: 0.4, ...(over.flushSample ? { flush_s: 1.2 } : {}) },
    samples, alloc_variant: "glibc", loadavg_start: "12.50 10.00 9.00 1/100 5", ...over,
  };
}

test("parseRuns keeps only JSON lines", () => {
  const text = `noise\n${JSON.stringify(run())}\n\n${JSON.stringify(run({ label: "y" }))}\n`;
  assert.deepEqual(parseRuns(text).map((r) => r.label), ["x", "y"]);
});

test("summaryRow: retained share is measured after trim, before-close uses the flushed sample when present", () => {
  const a = summaryRow(run());
  assert.equal(a.beforeCloseMib, 1010);
  assert.equal(a.peakMib, 1100);
  assert.equal(a.trimmedMib, 510);
  assert.equal(a.purgedMib, null);
  assert.equal(a.retainedShare, 0.5); // (510 − 10) / (1010 − 10)
  assert.equal(a.load1, 12.5);
  assert.equal(a.flushS, null);
  assert.equal(a.diskMib, 123.5);
  assert.equal(a.quadsOk, true);
  const b = summaryRow(run({ flushSample: true, purge: true, alloc_variant: "jemalloc" }));
  assert.equal(b.beforeCloseMib, 1110);
  assert.equal(b.purgedMib, 110);
  assert.equal(b.retainedShare, 0.09); // (110 − 10) / (1110 − 10)
  assert.equal(b.flushS, 1.2);
  assert.equal(summaryRow(run({ quads_after_reopen: 1 })).quadsOk, false);
});

test("sortRows orders by M, N, flush, then allocator", () => {
  const rows = sortRows([
    summaryRow(run({ m: 1000, n: 200 })),
    summaryRow(run({ m: 0, n: 50, alloc_variant: "jemalloc-conf" })),
    summaryRow(run({ m: 0, n: 50, alloc_variant: "glibc", flushSample: true })),
    summaryRow(run({ m: 0, n: 50, alloc_variant: "jemalloc" })),
  ]);
  assert.deepEqual(rows.map((r) => `${r.m}/${r.n}/${r.flush}/${r.allocator}`), [
    "0/50/false/jemalloc", "0/50/false/jemalloc-conf", "0/50/true/glibc", "1000/200/false/glibc",
  ]);
});

test("summaryMarkdown lists failed runs and the effective jemalloc options", () => {
  const md = summaryMarkdown([
    run({ alloc_variant: "jemalloc", jemalloc_opts: { "opt.background_thread": false } }),
    { label: "bad", error: "no JSON output" } as StoreCloseRun,
  ]);
  assert.match(md, /Failed: bad: no JSON output/);
  assert.match(md, /"opt.background_thread":false/);
  assert.equal(md.split("\n").filter((l) => l.startsWith("| 50 |")).length, 1);
});

test("summaryMarkdown drops a failure that a rerun of the same label replaced", () => {
  const md = summaryMarkdown([
    { label: "n200", error: "no JSON output" } as StoreCloseRun,
    run({ label: "n200", n: 200 }),
    { label: "other", error: "no JSON output" } as StoreCloseRun,
  ]);
  assert.doesNotMatch(md, /Failed: n200/);
  assert.match(md, /Failed: other: no JSON output/);
});

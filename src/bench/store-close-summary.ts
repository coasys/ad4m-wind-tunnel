/**
 * Summarise bench/store-close runs (runs.jsonl, one JSON line per run from
 * bench/store-close/run-matrix.sh) into a markdown table.
 *
 * Usage: npx tsx src/bench/store-close-summary.ts <dir-with-runs.jsonl>
 * Writes <dir>/SUMMARY.md and prints it.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

export interface MemSample {
  rss_mib: number;
  anon_mib: number;
  file_mib: number;
  hwm_mib: number;
  threads: number;
  alloc?: Record<string, number | string | null> | null;
}

export interface StoreCloseRun {
  label: string;
  error?: string;
  loadavg_start?: string;
  alloc_variant?: string;
  allocator?: string;
  jemalloc_opts?: Record<string, unknown> | null;
  n: number;
  m: number;
  flush: boolean;
  quads: number;
  quads_after_reopen: number;
  disk_mib: number;
  wal_mib: number;
  times: Record<string, number>;
  samples: Record<string, MemSample>;
}

export interface SummaryRow {
  n: number;
  m: number;
  flush: boolean;
  allocator: string;
  load1: number | null;
  startMib: number;
  peakMib: number;
  beforeCloseMib: number;
  closedMib: number;
  settledMib: number;
  trimmedMib: number;
  purgedMib: number | null;
  /** Share of (before close − start) still held after trim/purge. */
  retainedShare: number;
  reopenS: number;
  reopenCountS: number;
  reopenedMib: number;
  writeS: number;
  flushS: number | null;
  diskMib: number;
  quadsOk: boolean;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export function parseRuns(text: string): StoreCloseRun[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as StoreCloseRun);
}

export function summaryRow(r: StoreCloseRun): SummaryRow {
  const s = r.samples;
  const before = s.flushed ?? s.written;
  const finalMib = (s.closed_purged ?? s.closed_trimmed).rss_mib;
  const grown = before.rss_mib - s.start.rss_mib;
  return {
    n: r.n,
    m: r.m,
    flush: r.flush,
    allocator: r.alloc_variant ?? r.allocator ?? "?",
    load1: r.loadavg_start ? Number(r.loadavg_start.split(" ")[0]) : null,
    startMib: r1(s.start.rss_mib),
    peakMib: r1(before.hwm_mib),
    beforeCloseMib: r1(before.rss_mib),
    closedMib: r1(s.closed.rss_mib),
    settledMib: r1(s.closed_settled.rss_mib),
    trimmedMib: r1(s.closed_trimmed.rss_mib),
    purgedMib: s.closed_purged ? r1(s.closed_purged.rss_mib) : null,
    retainedShare: grown > 0 ? Math.round(((finalMib - s.start.rss_mib) / grown) * 100) / 100 : 0,
    reopenS: r.times.reopen_s,
    reopenCountS: r.times.reopen_count_s,
    reopenedMib: r1(s.reopened.rss_mib),
    writeS: r.times.write_s,
    flushS: r.times.flush_s ?? null,
    diskMib: r1(r.disk_mib),
    quadsOk: r.quads === r.quads_after_reopen,
  };
}

const ALLOC_ORDER = ["glibc", "jemalloc", "jemalloc-conf"];

export function sortRows(rows: SummaryRow[]): SummaryRow[] {
  return [...rows].sort(
    (a, b) =>
      a.m - b.m || a.n - b.n || Number(a.flush) - Number(b.flush) ||
      ALLOC_ORDER.indexOf(a.allocator) - ALLOC_ORDER.indexOf(b.allocator)
  );
}

export function summaryMarkdown(runs: StoreCloseRun[]): string {
  const ok = runs.filter((r) => !r.error && r.samples);
  // A failed row that a later rerun of the same label replaced is not a failure any more.
  const done = new Set(ok.map((r) => r.label));
  const failed = runs.filter((r) => (r.error || !r.samples) && !done.has(r.label));
  const rows = sortRows(ok.map(summaryRow));
  const opts = ok.find((r) => r.alloc_variant === "jemalloc")?.jemalloc_opts;
  const optsConf = ok.find((r) => r.alloc_variant === "jemalloc-conf")?.jemalloc_opts;
  const head = [
    "N stores", "M links/store", "Flush before close", "Allocator", "Load (1 min)", "RSS start MiB",
    "RSS before close MiB", "RSS right after close", "after settle", "after malloc_trim", "after jemalloc purge",
    "Share of growth still held", "Reopen s", "Reopen + count s", "RSS after reopen MiB", "Disk MiB",
  ];
  const lines = [
    "# Store close bench",
    "",
    "Oxigraph 0.5.13 (RocksDB), ADAM link shape, N stores × M links each. All RSS in MiB. " +
      "\"Share of growth still held\" = (RSS after trim/purge − RSS at start) / (RSS before close − RSS at start).",
    "",
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((x) =>
      `| ${[
        x.n, x.m, x.flush ? "yes" : "no", x.allocator, x.load1 ?? "?", x.startMib, x.beforeCloseMib, x.closedMib,
        x.settledMib, x.trimmedMib, x.purgedMib ?? "—", x.retainedShare, x.reopenS, x.reopenCountS, x.reopenedMib,
        x.diskMib,
      ].join(" | ")} |`
    ),
    "",
    `Effective jemalloc options, ADAM-style build (no MALLOC_CONF): \`${JSON.stringify(opts ?? null)}\``,
    "",
    `Effective jemalloc options with MALLOC_CONF set: \`${JSON.stringify(optsConf ?? null)}\``,
    "",
    ...(rows.some((x) => !x.quadsOk) ? ["**Warning:** some runs read back a different quad count after reopen.", ""] : []),
    ...failed.map((r) => `Failed: ${r.label}: ${r.error ?? "no samples"}`),
  ];
  return lines.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: store-close-summary.ts <dir-with-runs.jsonl>");
    process.exit(2);
  }
  const md = summaryMarkdown(parseRuns(readFileSync(join(dir, "runs.jsonl"), "utf8")));
  writeFileSync(join(dir, "SUMMARY.md"), md);
  console.log(md);
}

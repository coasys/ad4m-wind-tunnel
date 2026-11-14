# Slow executor fault (F1) and idle store close — 2026-11-14

Executor: ad4m 0.13.1-staging.11, commit 4226948b10e1 (the f1 markdown's "ad4m
commit: unknown" is only because `AD4M_REPO` was not passed; the commit is in
each JSON under `metrics.identity`). Holochain off. Machine: 32 cores, 123 GB.
Every measured run held `/tmp/arcadia-measure.lock`; the load average at the
start of each level and each bench row is in the result files.

## Spike 1 — F1: what happens when the executor is starved of CPU

### Set-up

- One perspective seeded with 30,000 links in the Flux/WE shape: channel
  messages and call transcript lines, each a `has_child` link plus a body or
  author link, read through reified-triple SPARQL ordered by timestamp.
- 10 clients, each on its own socket (as browsers are). Each holds two live
  queries (channel feed and call transcript, 50 rows each) and runs a page
  query (random offset) every ~10 s.
- 1 bot holding an "everything" live query.
- 4 speakers each writing a transcript line every second through `addLinks`
  (a live call).
- An auto-processor adding and removing an interpretation link every 2 s.
- Fault: a cgroup CPU quota on the executor's systemd scope. N× slower = 1/N of
  one core (4× = 25%, 20× = 5%, 100× = 1%). Phases: 30 s baseline, 60 s fault,
  90 s recovery, sampled every second.
- Optional churn (`F1_CHURN_SEC=15`): every client closes and re-opens its feed
  live query every ~15 s, like switching channel. Without churn no subscribe
  happens during the fault, so client behaviour on subscribe cannot matter.
- Client modes: `sdk` copies the current SDK (30 s call timeout,
  `request.cancel` on a timed-out subscribe, dispose by client id, backoff).
  `legacy` has no cancel and no dispose of a timed-out subscribe.

### Results

| Run | Slowdown | Pile-up? | Peak CPU in fault / right after | Peak evals running | Peak calls waiting | Timeouts | Writes seen live during fault | Recovery (CPU and backlog calm) | Leftover subscriptions at end |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sdk | 1× | no | 185% / 196% | 2 | 2 | 0 | 2,400 of 2,400 | 1 s | 0 |
| sdk | 4× | saturated, flat | 126% / 2,920% | 31 | 34 | 34 | 0 | 4 s | 0 |
| sdk | 20× | yes, growing | 185% / 2,782% | 37 | 151 | 96 | 0 | 4 s | 0 |
| sdk | 100× | saturated (capped by the 30 s timeout) | 128% / 3,053% | 45 | 151 | 140 | 0 | 4 s | 0 |
| sdk + churn | 20× | yes, growing | 240% / 2,892% | 64 | 171 | 143 | 0 | 5 s | 0 (20 cancelled) |
| sdk + churn | 100× | saturated | 65% / 3,117% | 69 | 171 | 170 | 0 | 9 s | ≈0 (29 cancelled) |
| legacy + churn | 20× | yes, growing | 104% / 3,081% | 53 | 147 | 53 | 0 | 4 s | 21 |
| legacy + churn | 100× | yes, growing | 96% / 3,129% | 76 | 171 | 178 | 0 | 10 s | 31 |

"Peak CPU" is % of one core for the executor and its children; the baseline is
60–500%. Recovery for the two churn runs comes from the saved samples
(`/tmp/hex-wt-f1/recompute-recovery.ts` logic): the sdk churn run predates the
`subCancels` counter, so its subscribe timeouts are counted as cancels. The
scenario's own "not recovered" verdict for those rows comes from leftover
subscriptions only. Leftover subscriptions = log "created" − "dropped" −
cancelled − live, an estimate (the log does not show silent removals).

Other numbers:

- During every fault from 4× up, **no page query completed** (all hit the
  30 s timeout). Writes: p50 282 ms at 4×, 19 s at 20×, 30 s (timeout) at 100×.
- The 1-minute load at the start of the legacy 20× level was 66.6 (another
  sweep had just ended); the other levels were 1–22.
- RSS rises 50–150 MB during the burst after the fault and stays there
  (330 → 480 MB).
- In the legacy runs the extra subscriptions did not raise idle CPU at this
  write rate (tail CPU 121–130% vs. baseline 117–129%).

### What the numbers say

- **There is no admission control.** Every request starts work at once. Under
  the quota, 30–76 evaluations share 1/N of a core, so none finishes inside
  the 30 s timeout and useful throughput falls to zero. At 100× evaluations drop
  to 0 while 150 calls wait, so calls also queue before evaluation (per
  connection, 8 running queries at most).
- **Timed-out page queries and writes keep running on the executor.** Only
  subscribes are cancelled by the SDK. When the quota lifts, all the kept work
  runs at once: a burst of about 28–31 cores. That matches production's
  1,000–2,700% spikes. The burst is the stored-up backlog, not new demand.
- **Recovery is fast here (4–10 s)** because steady demand (about 1 core) is far
  below capacity. With demand near capacity the same backlog would take far
  longer to clear. These runs do not test that.
- **The current SDK client does not cause a storm.** No re-subscribe loops;
  timed-out subscribes are cancelled and leave nothing behind. A legacy client
  leaves one orphaned subscription per subscribe that timed out (21 and 31
  here), which re-runs on every write until the socket closes.

### Which ADAM fix the data points to

1. **Server-side cancellation of timed-out work** (queries and writes, not
   only subscribes), or a server deadline that drops work whose caller has gone.
   This removes the burst on release.
2. **A bounded evaluation queue per perspective with admission control** (fail
   fast or shed when full). This keeps throughput up under starvation instead
   of splitting the CPU across 70 evaluations that all time out.
3. **A per-user query cap** next to the per-connection cap: today 10 sockets
   give 10× the cap.
4. **Subscription reuse:** 10 clients hold the same feed query; re-evaluating
   it once per write instead of per subscription cuts the steady cost.
5. Orphans (#1682-style) matter only for old clients: the current SDK already
   cancels. A server-side sweep of subscriptions whose first reply was never
   read would cover old clients.

Not done: a slow link-language fault mode. It needs a custom language bundle
published through the remote language store, and a slow language blocks only
its own language thread, not query evaluation, so it would test something
else.

## Spike 3 — store close: does closing an idle store give memory back?

`bench/store-close` opens N oxigraph 0.5.13 stores (ADAM's link shape, 8 quads
per link), writes M links into each, optionally flushes, drops them all, then
measures RSS right after the drop, after a 5 s settle, after `malloc_trim(0)`
and (jemalloc) after an explicit arena purge, then reopens and counts. Full
table: [store-close/SUMMARY.md](store-close/SUMMARY.md) (36 rows, no failures).

Allocators: `glibc`; `jemalloc` built like ADAM (unprefixed tikv-jemallocator,
`_rjem_malloc_conf` exported); `jemalloc-conf` = the same binary with
`MALLOC_CONF=background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000`
(ADAM's intended settings).

Key rows (RSS in MiB; start ≈ 13):

| N | M | Flush | Allocator | Before close | After close + 5 s | After trim / purge | Reopen s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 200 | 0 | no | glibc | 769 | 255 | 31 (trim) | 0.6 |
| 200 | 0 | no | jemalloc (as ADAM ships) | 777 | 775 | 37 (purge only) | 0.6 |
| 200 | 0 | no | jemalloc-conf | 779 | 38 | 38 | 0.6 |
| 200 | 10,000 | no | glibc | 8,598 | 259 | 36 (trim) | 36.6 |
| 200 | 10,000 | no | jemalloc (as ADAM ships) | 8,650 | 1,090 | 64 (purge only) | 33.3 |
| 200 | 10,000 | no | jemalloc-conf | 8,651 | 65 | 65 | 32.6 |
| 200 | 10,000 | yes | glibc | 820 | 302 | 54 (trim) | 7.8 |
| 200 | 10,000 | yes | jemalloc (as ADAM ships) | 964 | 824 | 68 (purge only) | 0.7 |
| 200 | 10,000 | yes | jemalloc-conf | 1,028 | 68 | 68 | 0.7 |

### What the numbers say

- **Closing a store frees almost all of its memory inside the process.** After
  trim or purge only 1–14% of the growth is left, in every cell.
- **Whether the OS gets it back depends on the allocator settings.**
  - jemalloc as ADAM ships it: almost nothing comes back on its own (775 MiB
    held at 200 empty stores, 1,090 MiB at 200 × 10k). With no background
    thread, decay runs only when the process allocates, and an idle process
    does not.
  - jemalloc with ADAM's intended settings: back to 38–68 MiB within 5 s.
  - glibc: keeps 255–300 MiB until `malloc_trim`.
- **ADAM's jemalloc settings are not applied today.** `cli/src/ad4m_executor.rs`
  exports `_rjem_malloc_conf`, but the unprefixed build reads `malloc_conf`. The
  built executor has no `dirty_decay_ms:1000` string and running executors have
  no jemalloc background thread. The bench's ADAM-style build reports
  `background_thread=false, dirty_decay_ms=10000, muzzy_decay_ms=0`.
- **Each open store costs about 3.8 MiB** with no data (769 MiB / 200), so 200
  open spaces cost about 750 MiB before any link.
- **Write buffers matter a lot while stores are open with unflushed writes.**
  At 10k links, 200 unflushed stores hold 8.6 GiB (about 43 MiB each, in
  memtables); flushed, 0.8–1.0 GiB. Unflushed stores also reopen slowly
  (33–37 s for 200, replaying the write-ahead log) against 0.7 s flushed
  (jemalloc).
- **Upstream cannot set them.** oxigraph 0.5.13 `StoreOptions` has only
  `with_max_open_files`, `with_unlimited_max_open_files` and `with_fd_reserve`
  (`src/store.rs:111–146`); the RocksDB wrapper sets no write-buffer size or
  block cache (`src/storage/rocksdb_wrapper.rs:146–164, 331–343`), so RocksDB's
  64 MB-per-column-family default applies. Smaller buffers need a fork change.

### What ADAM must do

1. Make the jemalloc settings take effect: export `malloc_conf` (not
   `_rjem_malloc_conf`) for the unprefixed build, or set `MALLOC_CONF` in the
   service. Without this, idle close gives nothing back to the OS.
2. Flush a store before closing it. Flushing cuts the memory held while it is
   open and makes reopening 5× (glibc) to 47× (jemalloc) faster at 200 × 10k.
3. Optionally purge jemalloc arenas after closing a batch of stores, so memory
   comes back without waiting for decay.
4. For memory while stores stay open: cap write buffers through the oxigraph
   fork, since upstream has no option.

## Files

- `f1/f1-sdk/`: sdk mode, levels 1, 4, 20, 100, no churn. Log: `f1/f1-sdk.log`.
- `f1/f1-churn-sdk/`, `f1/f1-churn-legacy/`: churn every 15 s, levels 20 and
  100. Log: `f1/f1-churn.log`. The sdk churn run predates `subCancels` and the
  `callsRecorded` field (its JSON has `executorPending.writesUnanswered`, which
  was really the total call count).
- `store-close/runs.jsonl`, `store-close/SUMMARY.md`, `store-close/matrix.log`.
  `runs.jsonl` also holds six early n200 failures (open-file limit of the
  systemd unit, since fixed); the summary drops them because each was rerun.

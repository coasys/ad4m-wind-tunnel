# f1-slow-executor — PASS

Branch label: `f1-churn-legacy` · duration 400.0 s

**Summary:** pileup from 20× slower; 20×: pileup, recovery none; 100×: pileup, recovery none

## Environment

| Field | Value |
| --- | --- |
| ad4m commit | unknown |
| Executor version | ad4m 0.13.1-staging.11 |
| Holochain (--run-holochain) | off |
| Machine | 32 CPUs (AMD RYZEN AI MAX+ 395 w/ Radeon 8060S), 122.8 GB RAM, linux-x64, kernel 7.0.0-38-generic |
| Load average start (1/5/15 min) | 78.49 / 45.58 / 21.83 |
| Load average end (1/5/15 min) | 1.33 / 13.11 / 14.76 |
| Host swap used start / end | 8349852 kB / 8349768 kB |
| Run | 1 |
| Started | 2026-11-14T04:15:58.626Z |

# F1: Slow Executor

Executor 4226948b10e11d4227321c9744bf1cc72e5cb580 (0.13.1-staging.11), Holochain off. Space: perspective (no neighbourhood), 30000 seed links.
Clients: 10 app clients (2 live queries + a page query every 10s each), 1 bot(s) with an "everything" query (links); client mode **legacy**, call timeout 30000 ms.
Writes: 4 speakers × 1 line / 1000 ms; auto-processor add+remove every 2000 ms.
Channel switching: each client closes and re-opens its feed live query every ~15s.
Phases: baseline 30s → fault 60s → recovery 90s. Slowdown N× = CPU quota of 1/N of one core on the executor's cgroup.

**Summary:** pileup from 20× slower; 20×: pileup, recovery none; 100×: pileup, recovery none

| Slowdown | Pileup | Peak CPU % (fault / recovery) | Peak evals running | Peak executor subs | Peak client calls in flight | Timeouts | Re-subscribes | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20× | yes | 104.1 / 3081.08 | 53 | 51 | 147 | 53 | 0 | not recovered |
| 100× | yes | 96.1 / 3129 | 76 | 59 | 171 | 178 | 0 | not recovered |

### 20× slower (CPU quota 5% of one core, cpu.max during fault: 5000 100000)

Load at start: 66.58 / 44.12 / 21.61. Boot 58 ms, perspective answered 2698 ms after, initial subscribes 1022 ms.

**Pileup: YES** — backlog still growing at 122.7/min at the end of the fault, 185 vs baseline 9. **Recovery:** not within the recovery window.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 362.36 | 358.27 | 129 | 5 | 21 | 5 | 363 / 380 (20, 0) | 361 / 391 (28, 0) | 2 / 42 (150, 0) | 686 / 821 (1200 / 120) |
| fault | 104.1 | 384.21 | 201 | 51 | 38 | 144 | 30000 / 30003 (20, 20) | 30000 / 30001 (30, 30) | 2663 / 29359 (162, 1) | — / — (0 / 240) |
| recovery | 3081.08 | 484.82 | 212 | 53 | 51 | 147 | 376 / 26446 (77, 0) | 376 / 29999 (115, 2) | 2 / 24004 (548, 0) | 753 / 39758 (4480 / 360) |

Totals: 53 client timeouts, 0 re-subscribes, 118 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 139 subscriptions created, 98 dropped, 0 subscribes cancelled by the client (each removed without a log line); cgroup throttled 1484 s.

### 100× slower (CPU quota 1% of one core, cpu.max during fault: 1000 100000)

Load at start: 4.62 / 24.39 / 18.01. Boot 109 ms, perspective answered 1582 ms after, initial subscribes 5327 ms.

**Pileup: YES** — backlog still growing at 39.9/min at the end of the fault, 209 vs baseline 9. **Recovery:** not within the recovery window.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 384.77 | 336.31 | 129 | 4 | 21 | 4 | 386 / 432 (20, 0) | 380 / 396 (30, 0) | 3 / 43 (150, 0) | 720 / 821 (1200 / 120) |
| fault | 96.1 | 343.35 | 177 | 26 | 29 | 171 | 30000 / 30001 (21, 21) | 30001 / 30002 (26, 26) | 30000 / 30001 (122, 114) | — / — (0 / 240) |
| recovery | 3129 | 477.45 | 239 | 76 | 59 | 169 | 405 / 30000 (79, 9) | 398 / 30000 (111, 4) | 2 / 29179 (572, 4) | 752 / 16047 (3780 / 360) |

Totals: 178 client timeouts, 0 re-subscribes, 121 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 142 subscriptions created, 91 dropped, 0 subscribes cancelled by the client (each removed without a log line); cgroup throttled 1508 s.

Live subscriptions on the executor come from its log (created − dropped), an upper bound: a subscribe that fails or is cancelled before it registers logs nothing. Evaluations running = threads named `ad4m-eval-watchdog` (one per running SPARQL evaluation).


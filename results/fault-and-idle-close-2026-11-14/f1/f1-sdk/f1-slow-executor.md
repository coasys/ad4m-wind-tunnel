# f1-slow-executor — PASS

Branch label: `f1-sdk` · duration 790.2 s

**Summary:** pileup from 20× slower; 1×: no pileup, recovery 1s; 4×: no pileup, recovery 4s; 20×: pileup, recovery 4s; 100×: no pileup, recovery 4s

## Environment

| Field | Value |
| --- | --- |
| ad4m commit | unknown |
| Executor version | ad4m 0.13.1-staging.11 |
| Holochain (--run-holochain) | off |
| Machine | 32 CPUs (AMD RYZEN AI MAX+ 395 w/ Radeon 8060S), 122.8 GB RAM, linux-x64, kernel 7.0.0-38-generic |
| Load average start (1/5/15 min) | 1.46 / 2.94 / 11.66 |
| Load average end (1/5/15 min) | 0.83 / 1.73 / 5.95 |
| Host swap used start / end | 8361384 kB / 8350800 kB |
| Run | 1 |
| Started | 2026-11-14T03:47:09.999Z |

# F1: Slow Executor

Executor 4226948b10e11d4227321c9744bf1cc72e5cb580 (0.13.1-staging.11), Holochain off. Space: perspective (no neighbourhood), 30000 seed links.
Clients: 10 app clients (2 live queries + a page query every 10s each), 1 bot(s) with an "everything" query (links); client mode **sdk**, call timeout 30000 ms.
Writes: 4 speakers × 1 line / 1000 ms; auto-processor add+remove every 2000 ms.
Phases: baseline 30s → fault 60s → recovery 90s. Slowdown N× = CPU quota of 1/N of one core on the executor's cgroup.

**Summary:** pileup from 20× slower; 1×: no pileup, recovery 1s; 4×: no pileup, recovery 4s; 20×: pileup, recovery 4s; 100×: no pileup, recovery 4s

| Slowdown | Pileup | Peak CPU % (fault / recovery) | Peak evals running | Peak executor subs | Peak client calls in flight | Timeouts | Re-subscribes | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1× | no | 185 / 196.39 | 2 | 21 | 2 | 0 | 0 | 1 s |
| 4× | no | 126.13 / 2920 | 31 | 21 | 34 | 34 | 0 | 4 s |
| 20× | yes | 185 / 2781.78 | 37 | 21 | 151 | 96 | 0 | 4 s |
| 100× | no | 128.13 / 3053 | 45 | 21 | 151 | 140 | 0 | 4 s |

### 1× slower (CPU quota none, cpu.max during fault: unbounded)

Load at start: 1.32 / 2.86 / 11.54. Boot 59 ms, perspective answered 2683 ms after, initial subscribes 4735 ms.

**Pileup: no** — backlog stayed near baseline (1 vs 4). **Recovery:** 1 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 208 | 343.18 | 126 | 3 | 21 | 3 | — / — (0, 0) | 365 / 389 (30, 0) | 2 / 42 (150, 0) | 716 / 820 (1200 / 120) |
| fault | 185 | 290.39 | 125 | 2 | 21 | 2 | — / — (0, 0) | 362 / 386 (54, 0) | 2 / 43 (300, 0) | 717 / 828 (2400 / 240) |
| recovery | 196.39 | 292.51 | 125 | 2 | 21 | 2 | — / — (0, 0) | 368 / 429 (85, 0) | 2 / 43 (450, 0) | 699 / 840 (3600 / 360) |

Totals: 0 client timeouts, 0 re-subscribes, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 21 subscriptions created, 0 dropped; cgroup throttled 0 s.

### 4× slower (CPU quota 25% of one core, cpu.max during fault: 25000 100000)

Load at start: 1.05 / 1.99 / 9.55. Boot 110 ms, perspective answered 1626 ms after, initial subscribes 1556 ms.

**Pileup: no** — backlog high (60 vs baseline 4) but flat (0.9/min): saturated, bounded. **Recovery:** 4 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 318.32 | 322.73 | 133 | 6 | 21 | 6 | — / — (0, 0) | 381 / 408 (23, 0) | 3 / 44 (150, 0) | 729 / 816 (1200 / 120) |
| fault | 126.13 | 341.79 | 198 | 31 | 21 | 34 | — / — (0, 0) | 30000 / 30002 (30, 30) | 282 / 2583 (298, 0) | — / — (0 / 240) |
| recovery | 2920 | 406.15 | 198 | 30 | 21 | 31 | — / — (0, 0) | 394 / 30000 (116, 4) | 2 / 44 (452, 0) | 670 / 13410 (4100 / 360) |

Totals: 34 client timeouts, 0 re-subscribes, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 21 subscriptions created, 0 dropped; cgroup throttled 1229 s.

### 20× slower (CPU quota 5% of one core, cpu.max during fault: 5000 100000)

Load at start: 1.3 / 1.6 / 7.95. Boot 82 ms, perspective answered 1893 ms after, initial subscribes 1592 ms.

**Pileup: YES** — backlog still growing at 78.0/min at the end of the fault, 162 vs baseline 5. **Recovery:** 4 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 331.67 | 340.48 | 128 | 3 | 21 | 3 | — / — (0, 0) | 511 / 648 (26, 0) | 2 / 43 (150, 0) | 951 / 1267 (1160 / 120) |
| fault | 185 | 325.05 | 173 | 28 | 21 | 151 | — / — (0, 0) | 30000 / 30002 (30, 30) | 19120 / 30002 (129, 58) | — / — (0 / 240) |
| recovery | 2781.78 | 366.84 | 191 | 37 | 21 | 151 | — / — (0, 0) | 454 / 30001 (118, 4) | 2 / 29050 (572, 4) | 812 / 36691 (4100 / 360) |

Totals: 96 client timeouts, 0 re-subscribes, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 21 subscriptions created, 0 dropped; cgroup throttled 1404 s.

### 100× slower (CPU quota 1% of one core, cpu.max during fault: 1000 100000)

Load at start: 1.67 / 2.32 / 7.09. Boot 109 ms, perspective answered 1753 ms after, initial subscribes 3816 ms.

**Pileup: no** — backlog high (150 vs baseline 6) but flat (-20.8/min): saturated, bounded. **Recovery:** 4 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 222.78 | 328.73 | 128 | 4 | 21 | 4 | — / — (0, 0) | 392 / 469 (24, 0) | 2 / 43 (150, 0) | 744 / 851 (1200 / 120) |
| fault | 128.13 | 309.66 | 153 | 18 | 21 | 151 | — / — (0, 0) | 30000 / 30001 (29, 29) | 30000 / 30001 (125, 106) | — / — (0 / 240) |
| recovery | 3053 | 444.34 | 209 | 45 | 21 | 151 | — / — (0, 0) | 399 / 29853 (113, 1) | 41 / 29081 (572, 4) | 687 / 12898 (4060 / 360) |

Totals: 140 client timeouts, 0 re-subscribes, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 21 subscriptions created, 0 dropped; cgroup throttled 1161 s.

Live subscriptions on the executor come from its log (created − dropped), an upper bound: a subscribe that fails or is cancelled before it registers logs nothing. Evaluations running = threads named `ad4m-eval-watchdog` (one per running SPARQL evaluation).


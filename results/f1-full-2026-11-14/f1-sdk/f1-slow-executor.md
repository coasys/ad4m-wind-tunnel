# f1-slow-executor — PASS

Branch label: `f1-sdk` · duration 1576.4 s

**Summary:** pileup from 20× slower; 1×: no pileup, recovery 1s; 4×: no pileup, recovery 4s; 20×: pileup, recovery 7s; 100×: pileup, recovery 5s

## Environment

| Field | Value |
| --- | --- |
| ad4m commit | unknown |
| Executor version | ad4m 0.13.1-staging.11 |
| Holochain (--run-holochain) | off |
| Machine | 32 CPUs (AMD RYZEN AI MAX+ 395 w/ Radeon 8060S), 122.8 GB RAM, linux-x64, kernel 7.0.0-38-generic |
| Load average start (1/5/15 min) | 1.63 / 6.46 / 9.83 |
| Load average end (1/5/15 min) | 4.96 / 25.66 / 30.07 |
| Host swap used start / end | 8349120 kB / 8388448 kB |
| Run | 1 |
| Started | 2026-11-14T04:45:49.438Z |

# F1: Slow Executor

Executor 4226948b10e11d4227321c9744bf1cc72e5cb580 (0.13.1-staging.11), Holochain off. Space: perspective (no neighbourhood), 30000 seed links.
Clients: 10 app clients (2 live queries + a page query every 10s each), 1 bot(s) with an "everything" query (links); client mode **sdk**, call timeout 30000 ms.
Writes: 4 speakers × 1 line / 1000 ms; auto-processor add+remove every 2000 ms.
Channel switching: off (live queries open once).
Phases: baseline 60s → fault 120s → recovery 180s. Slowdown N× = CPU quota of 1/N of one core on the executor's cgroup.

**Summary:** pileup from 20× slower; 1×: no pileup, recovery 1s; 4×: no pileup, recovery 4s; 20×: pileup, recovery 7s; 100×: pileup, recovery 5s

| Slowdown | Pileup | Peak CPU % (fault / recovery) | Peak evals running | Peak executor subs | Peak client calls in flight | Timeouts | Re-subscribes | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1× | no | 367.37 / 320.68 | 5 | 21 | 4 | 0 | 0 | 1 s |
| 4× | no | 239 / 2131 | 32 | 21 | 39 | 85 | 0 | 4 s |
| 20× | yes | 99 / 789.16 | 40 | 21 | 125 | 130 | 0 | 7 s |
| 100× | yes | 260.48 / 2557 | 56 | 21 | 151 | 428 | 0 | 5 s |

### 1× slower (CPU quota none, cpu.max during fault: unbounded)

Load at start: 1.7 / 6.31 / 9.74. Boot 57 ms, perspective answered 3295 ms after, initial subscribes 1690 ms.

**Pileup: no** — backlog stayed near baseline (3 vs 4). **Recovery:** 1 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 267 | 311.2 | 127 | 3 | 21 | 3 | — / — (0, 0) | 372 / 438 (56, 0) | 3 / 43 (300, 0) | 736 / 824 (2400 / 240) |
| fault | 367.37 | 305.41 | 129 | 5 | 21 | 4 | — / — (0, 0) | 783 / 915 (118, 0) | 2 / 46 (600, 0) | 1291 / 2044 (4760 / 480) |
| recovery | 320.68 | 311.05 | 129 | 5 | 21 | 3 | — / — (0, 0) | 800 / 920 (174, 0) | 2 / 44 (900, 0) | 1442 / 2081 (7240 / 720) |

Totals: 0 client timeouts, 0 re-subscribes, 0 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 21 subscriptions created, 0 dropped, 0 subscribes cancelled by the client (each removed without a log line); cgroup throttled 0 s.

### 4× slower (CPU quota 25% of one core, cpu.max during fault: 25000 100000)

Load at start: 42.5 / 31.62 / 19.6. Boot 118 ms, perspective answered 2369 ms after, initial subscribes 6579 ms.

**Pileup: no** — backlog high (60 vs baseline 6) but flat (-2.6/min): saturated, bounded. **Recovery:** 4 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 391.61 | 381.52 | 132 | 4 | 21 | 3 | — / — (0, 0) | 705 / 965 (56, 0) | 2 / 45 (300, 0) | 1220 / 2061 (2400 / 240) |
| fault | 239 | 429.78 | 212 | 32 | 21 | 39 | — / — (0, 0) | 30000 / 30001 (88, 85) | 217 / 3774 (598, 0) | 102475 / 104484 (200 / 480) |
| recovery | 2131 | 457.57 | 206 | 31 | 21 | 29 | — / — (0, 0) | 473 / 26622 (201, 0) | 1 / 43 (900, 0) | 824 / 26369 (8080 / 720) |

Totals: 85 client timeouts, 0 re-subscribes, 0 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 21 subscriptions created, 0 dropped, 0 subscribes cancelled by the client (each removed without a log line); cgroup throttled 2011 s.

### 20× slower (CPU quota 5% of one core, cpu.max during fault: 5000 100000)

Load at start: 29.14 / 30.9 / 23.76. Boot 149 ms, perspective answered 3638 ms after, initial subscribes 12256 ms.

**Pileup: YES** — backlog still growing at 21.6/min at the end of the fault, 139 vs baseline 8. **Recovery:** 7 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 441.44 | 280.76 | 133 | 5 | 21 | 3 | — / — (0, 0) | 895 / 1023 (60, 0) | 2 / 44 (300, 0) | 1526 / 2315 (2360 / 240) |
| fault | 99 | 451.71 | 188 | 31 | 21 | 125 | — / — (0, 0) | 30001 / 30005 (86, 86) | 9091 / 30002 (411, 38) | — / — (0 / 480) |
| recovery | 789.16 | 419.38 | 199 | 40 | 21 | 125 | — / — (0, 0) | 670 / 30001 (199, 6) | 2 / 24935 (997, 0) | 1112 / 14381 (7580 / 720) |

Totals: 130 client timeouts, 0 re-subscribes, 0 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 21 subscriptions created, 0 dropped, 0 subscribes cancelled by the client (each removed without a log line); cgroup throttled 1909 s.

### 100× slower (CPU quota 1% of one core, cpu.max during fault: 1000 100000)

Load at start: 16.46 / 39.16 / 32.13. Boot 110 ms, perspective answered 2589 ms after, initial subscribes 13185 ms.

**Pileup: YES** — backlog still growing at 51.0/min at the end of the fault, 186 vs baseline 8. **Recovery:** 5 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 363.55 | 289.96 | 133 | 6 | 21 | 4 | — / — (0, 0) | 851 / 1258 (58, 0) | 2 / 45 (300, 0) | 1386 / 2215 (2400 / 240) |
| fault | 260.48 | 380.59 | 230 | 51 | 21 | 151 | — / — (0, 0) | 30000 / 30190 (87, 87) | 30000 / 30001 (365, 334) | — / — (0 / 480) |
| recovery | 2557 | 564.68 | 234 | 56 | 21 | 151 | — / — (0, 0) | 448 / 30000 (204, 3) | 2 / 28251 (1022, 4) | 823 / 38389 (7660 / 720) |

Totals: 428 client timeouts, 0 re-subscribes, 0 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 21 subscriptions created, 0 dropped, 0 subscribes cancelled by the client (each removed without a log line); cgroup throttled 2437 s.

Live subscriptions on the executor come from its log (created − dropped), an upper bound: a subscribe that fails or is cancelled before it registers logs nothing. Evaluations running = threads named `ad4m-eval-watchdog` (one per running SPARQL evaluation).


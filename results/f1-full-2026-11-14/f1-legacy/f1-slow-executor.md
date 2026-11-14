# f1-slow-executor — PASS

Branch label: `f1-legacy` · duration 816.0 s

**Summary:** pileup from 20× slower; 20×: pileup, recovery 4s; 100×: no pileup, recovery 7s

## Environment

| Field | Value |
| --- | --- |
| ad4m commit | unknown |
| Executor version | ad4m 0.13.1-staging.11 |
| Holochain (--run-holochain) | off |
| Machine | 32 CPUs (AMD RYZEN AI MAX+ 395 w/ Radeon 8060S), 122.8 GB RAM, linux-x64, kernel 7.0.0-38-generic |
| Load average start (1/5/15 min) | 55.40 / 25.40 / 23.04 |
| Load average end (1/5/15 min) | 8.33 / 12.56 / 18.51 |
| Host swap used start / end | 8388428 kB / 8057756 kB |
| Run | 1 |
| Started | 2026-11-14T05:25:14.766Z |

# F1: Slow Executor

Executor 4226948b10e11d4227321c9744bf1cc72e5cb580 (0.13.1-staging.11), Holochain off. Space: perspective (no neighbourhood), 30000 seed links.
Clients: 10 app clients (2 live queries + a page query every 10s each), 1 bot(s) with an "everything" query (links); client mode **legacy**, call timeout 30000 ms.
Writes: 4 speakers × 1 line / 1000 ms; auto-processor add+remove every 2000 ms.
Channel switching: off (live queries open once).
Phases: baseline 60s → fault 120s → recovery 180s. Slowdown N× = CPU quota of 1/N of one core on the executor's cgroup.

**Summary:** pileup from 20× slower; 20×: pileup, recovery 4s; 100×: no pileup, recovery 7s

| Slowdown | Pileup | Peak CPU % (fault / recovery) | Peak evals running | Peak executor subs | Peak client calls in flight | Timeouts | Re-subscribes | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20× | yes | 289 / 3020.02 | 38 | 21 | 130 | 100 | 0 | 4 s |
| 100× | no | 141.86 / 1835 | 80 | 21 | 151 | 421 | 0 | 7 s |

### 20× slower (CPU quota 5% of one core, cpu.max during fault: 5000 100000)

Load at start: 61.5 / 29.75 / 24.56. Boot 161 ms, perspective answered 9995 ms after, initial subscribes 9423 ms.

**Pileup: YES** — backlog still growing at 73.2/min at the end of the fault, 127 vs baseline 7. **Recovery:** 4 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 468 | 295.2 | 131 | 5 | 21 | 4 | — / — (0, 0) | 796 / 918 (59, 0) | 2 / 45 (300, 0) | 1462 / 2029 (2400 / 240) |
| fault | 289 | 382.41 | 184 | 30 | 21 | 130 | — / — (0, 0) | 30000 / 30001 (84, 84) | 3511 / 30000 (428, 16) | — / — (0 / 480) |
| recovery | 3020.02 | 390.8 | 193 | 38 | 21 | 118 | — / — (0, 0) | 405 / 29482 (197, 0) | 2 / 22998 (992, 0) | 778 / 13348 (7660 / 720) |

Totals: 100 client timeouts, 0 re-subscribes, 0 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 21 subscriptions created, 0 dropped, 0 subscribes cancelled by the client (each removed without a log line); cgroup throttled 2242 s.

### 100× slower (CPU quota 1% of one core, cpu.max during fault: 1000 100000)

Load at start: 9.81 / 20.11 / 23.02. Boot 85 ms, perspective answered 1970 ms after, initial subscribes 2103 ms.

**Pileup: no** — backlog high (150 vs baseline 6) but flat (-30.2/min): saturated, bounded. **Recovery:** 7 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 286 | 282.96 | 129 | 5 | 21 | 3 | — / — (0, 0) | 433 / 909 (58, 0) | 2 / 44 (300, 0) | 802 / 1959 (2360 / 240) |
| fault | 141.86 | 363.49 | 184 | 26 | 21 | 151 | — / — (0, 0) | 30000 / 30001 (87, 87) | 30000 / 30001 (366, 325) | — / — (0 / 480) |
| recovery | 1835 | 515.89 | 277 | 80 | 21 | 149 | — / — (0, 0) | 457 / 30000 (199, 5) | 2 / 28245 (1022, 4) | 830 / 21381 (7660 / 720) |

Totals: 421 client timeouts, 0 re-subscribes, 0 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 21 subscriptions created, 0 dropped, 0 subscribes cancelled by the client (each removed without a log line); cgroup throttled 2273 s.

Live subscriptions on the executor come from its log (created − dropped), an upper bound: a subscribe that fails or is cancelled before it registers logs nothing. Evaluations running = threads named `ad4m-eval-watchdog` (one per running SPARQL evaluation).


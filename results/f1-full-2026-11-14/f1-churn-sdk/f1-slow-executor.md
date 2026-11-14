# f1-slow-executor — PASS

Branch label: `f1-churn-sdk` · duration 1553.8 s

**Summary:** pileup from 100× slower; 1×: no pileup, recovery 1s; 4×: no pileup, recovery 6s; 20×: no pileup, recovery 5s; 100×: pileup, recovery 7s

## Environment

| Field | Value |
| --- | --- |
| ad4m commit | unknown |
| Executor version | ad4m 0.13.1-staging.11 |
| Holochain (--run-holochain) | off |
| Machine | 32 CPUs (AMD RYZEN AI MAX+ 395 w/ Radeon 8060S), 122.8 GB RAM, linux-x64, kernel 7.0.0-38-generic |
| Load average start (1/5/15 min) | 9.40 / 5.29 / 9.56 |
| Load average end (1/5/15 min) | 2.63 / 3.88 / 5.25 |
| Host swap used start / end | 7721548 kB / 7721384 kB |
| Run | 1 |
| Started | 2026-11-14T05:59:38.586Z |

# F1: Slow Executor

Executor 4226948b10e11d4227321c9744bf1cc72e5cb580 (0.13.1-staging.11), Holochain off. Space: perspective (no neighbourhood), 30000 seed links.
Clients: 10 app clients (2 live queries + a page query every 10s each), 1 bot(s) with an "everything" query (links); client mode **sdk**, call timeout 30000 ms.
Writes: 4 speakers × 1 line / 1000 ms; auto-processor add+remove every 2000 ms.
Channel switching: each client closes and re-opens its feed live query every ~15s.
Phases: baseline 60s → fault 120s → recovery 180s. Slowdown N× = CPU quota of 1/N of one core on the executor's cgroup.

**Summary:** pileup from 100× slower; 1×: no pileup, recovery 1s; 4×: no pileup, recovery 6s; 20×: no pileup, recovery 5s; 100×: pileup, recovery 7s

| Slowdown | Pileup | Peak CPU % (fault / recovery) | Peak evals running | Peak executor subs | Peak client calls in flight | Timeouts | Re-subscribes | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1× | no | 245.25 / 275 | 3 | 21 | 3 | 0 | 0 | 1 s |
| 4× | no | 202 / 3020.98 | 60 | 88 | 114 | 146 | 0 | 6 s |
| 20× | no | 146.85 / 3020 | 69 | 74 | 171 | 383 | 0 | 5 s |
| 100× | yes | 85.91 / 3053.05 | 82 | 40 | 171 | 497 | 0 | 7 s |

### 1× slower (CPU quota none, cpu.max during fault: unbounded)

Load at start: 10.18 / 5.6 / 9.62. Boot 58 ms, perspective answered 3350 ms after, initial subscribes 5646 ms.

**Pileup: no** — backlog stayed near baseline (1 vs 9). **Recovery:** 1 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 406 | 311.17 | 131 | 5 | 21 | 5 | 386 / 796 (40, 0) | 388 / 457 (58, 0) | 1 / 43 (300, 0) | 740 / 1039 (2400 / 240) |
| fault | 245.25 | 321.61 | 129 | 3 | 21 | 3 | 392 / 437 (77, 0) | 391 / 427 (116, 0) | 1 / 43 (600, 0) | 726 / 854 (4800 / 480) |
| recovery | 275 | 329.7 | 129 | 3 | 21 | 3 | 393 / 427 (116, 0) | 394 / 430 (174, 0) | 1 / 43 (900, 0) | 731 / 852 (7200 / 720) |

Totals: 0 client timeouts, 0 re-subscribes, 243 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 264 subscriptions created, 243 dropped, 0 subscribes cancelled by the client (each removed without a log line); cgroup throttled 0 s.

### 4× slower (CPU quota 25% of one core, cpu.max during fault: 25000 100000)

Load at start: 2.9 / 3.48 / 7.26. Boot 84 ms, perspective answered 1833 ms after, initial subscribes 1989 ms.

**Pileup: no** — backlog high (117 vs baseline 8) but flat (-8.0/min): saturated, bounded. **Recovery:** 6 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 445 | 295.55 | 127 | 3 | 21 | 4 | 411 / 508 (40, 0) | 411 / 479 (57, 0) | 2 / 43 (300, 0) | 758 / 904 (2400 / 240) |
| fault | 202 | 438.81 | 232 | 60 | 84 | 114 | 30000 / 30001 (55, 55) | 30000 / 30001 (86, 84) | 215 / 17084 (580, 0) | 118881 / 118884 (40 / 480) |
| recovery | 3020.98 | 460.54 | 216 | 50 | 88 | 49 | 436 / 30000 (136, 4) | 440 / 29999 (200, 3) | 2 / 43 (900, 0) | 811 / 11429 (7540 / 720) |

Totals: 146 client timeouts, 0 re-subscribes, 241 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 262 subscriptions created, 182 dropped, 59 subscribes cancelled by the client (each removed without a log line); cgroup throttled 2646 s.

### 20× slower (CPU quota 5% of one core, cpu.max during fault: 5000 100000)

Load at start: 3.61 / 4.31 / 6.28. Boot 86 ms, perspective answered 2091 ms after, initial subscribes 2143 ms.

**Pileup: no** — backlog high (182 vs baseline 8) but flat (-50.6/min): saturated, bounded. **Recovery:** 5 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 487.98 | 323.23 | 129 | 5 | 21 | 4 | 537 / 949 (40, 0) | 596 / 949 (58, 0) | 1 / 43 (300, 0) | 916 / 2172 (2440 / 240) |
| fault | 146.85 | 489.31 | 219 | 56 | 55 | 171 | 30000 / 30002 (55, 55) | 30000 / 30002 (85, 85) | 30000 / 30001 (373, 229) | — / — (0 / 480) |
| recovery | 3020 | 528.21 | 236 | 69 | 74 | 170 | 505 / 30000 (135, 3) | 505 / 30000 (202, 6) | 1 / 28081 (1020, 4) | 837 / 71005 (8080 / 720) |

Totals: 383 client timeouts, 0 re-subscribes, 240 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 249 subscriptions created, 185 dropped, 58 subscribes cancelled by the client (each removed without a log line); cgroup throttled 2879 s.

### 100× slower (CPU quota 1% of one core, cpu.max during fault: 1000 100000)

Load at start: 6.47 / 5.81 / 6.35. Boot 83 ms, perspective answered 2308 ms after, initial subscribes 2511 ms.

**Pileup: YES** — backlog still growing at 5.1/min at the end of the fault, 174 vs baseline 6. **Recovery:** 7 s after the fault ended.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 423 | 314.27 | 129 | 4 | 21 | 4 | 431 / 500 (40, 0) | 435 / 476 (56, 0) | 2 / 43 (300, 0) | 780 / 887 (2400 / 240) |
| fault | 85.91 | 406.27 | 166 | 29 | 22 | 171 | 30000 / 30001 (57, 57) | 30000 / 30002 (87, 87) | 30000 / 30001 (365, 341) | — / — (0 / 480) |
| recovery | 3053.05 | 574.29 | 274 | 82 | 40 | 171 | 437 / 30000 (139, 3) | 438 / 30000 (201, 5) | 2 / 28218 (1022, 4) | 814 / 120505 (8020 / 720) |

Totals: 497 client timeouts, 0 re-subscribes, 246 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 220 subscriptions created, 187 dropped, 60 subscribes cancelled by the client (each removed without a log line); cgroup throttled 2665 s.

Live subscriptions on the executor come from its log (created − dropped), an upper bound: a subscribe that fails or is cancelled before it registers logs nothing. Evaluations running = threads named `ad4m-eval-watchdog` (one per running SPARQL evaluation).


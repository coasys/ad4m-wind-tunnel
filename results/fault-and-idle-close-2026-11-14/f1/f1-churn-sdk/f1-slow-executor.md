# f1-slow-executor — PASS

Branch label: `f1-churn-sdk` · duration 400.9 s

**Summary:** pileup from 20× slower; 20×: pileup, recovery none; 100×: no pileup, recovery none

## Environment

| Field | Value |
| --- | --- |
| ad4m commit | unknown |
| Executor version | ad4m 0.13.1-staging.11 |
| Holochain (--run-holochain) | off |
| Machine | 32 CPUs (AMD RYZEN AI MAX+ 395 w/ Radeon 8060S), 122.8 GB RAM, linux-x64, kernel 7.0.0-38-generic |
| Load average start (1/5/15 min) | 25.72 / 10.29 / 8.16 |
| Load average end (1/5/15 min) | 3.13 / 4.00 / 5.85 |
| Host swap used start / end | 8350636 kB / 8350164 kB |
| Run | 1 |
| Started | 2026-11-14T04:03:43.271Z |

# F1: Slow Executor

Executor 4226948b10e11d4227321c9744bf1cc72e5cb580 (0.13.1-staging.11), Holochain off. Space: perspective (no neighbourhood), 30000 seed links.
Clients: 10 app clients (2 live queries + a page query every 10s each), 1 bot(s) with an "everything" query (links); client mode **sdk**, call timeout 30000 ms.
Writes: 4 speakers × 1 line / 1000 ms; auto-processor add+remove every 2000 ms.
Channel switching: each client closes and re-opens its feed live query every ~15s.
Phases: baseline 30s → fault 60s → recovery 90s. Slowdown N× = CPU quota of 1/N of one core on the executor's cgroup.

**Summary:** pileup from 20× slower; 20×: pileup, recovery none; 100×: no pileup, recovery none

| Slowdown | Pileup | Peak CPU % (fault / recovery) | Peak evals running | Peak executor subs | Peak client calls in flight | Timeouts | Re-subscribes | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20× | yes | 239.76 / 2892 | 64 | 51 | 171 | 143 | 0 | not recovered |
| 100× | no | 65 / 3116.88 | 69 | 45 | 171 | 170 | 0 | not recovered |

### 20× slower (CPU quota 5% of one core, cpu.max during fault: 5000 100000)

Load at start: 21.92 / 9.99 / 8.08. Boot 59 ms, perspective answered 2585 ms after, initial subscribes 2227 ms.

**Pileup: YES** — backlog still growing at 28.8/min at the end of the fault, 199 vs baseline 9. **Recovery:** not within the recovery window.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 494 | 329.84 | 129 | 5 | 21 | 5 | 364 / 398 (20, 0) | 369 / 412 (25, 0) | 2 / 43 (150, 0) | 684 / 799 (1200 / 120) |
| fault | 239.76 | 374.17 | 167 | 30 | 26 | 171 | 30000 / 30001 (20, 20) | 30000 / 30001 (28, 28) | 30000 / 30001 (128, 88) | — / — (0 / 240) |
| recovery | 2892 | 483.49 | 225 | 64 | 51 | 169 | 379 / 27939 (80, 0) | 381 / 30000 (116, 5) | 2 / 29005 (571, 1) | 753 / 60675 (4480 / 360) |

Totals: 143 client timeouts, 0 re-subscribes, 120 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 141 subscriptions created, 100 dropped; cgroup throttled 1426 s.

### 100× slower (CPU quota 1% of one core, cpu.max during fault: 1000 100000)

Load at start: 2.42 / 5.9 / 6.82. Boot 83 ms, perspective answered 1697 ms after, initial subscribes 4938 ms.

**Pileup: no** — backlog high (190 vs baseline 9) but flat (-5.4/min): saturated, bounded. **Recovery:** not within the recovery window.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 366 | 332.32 | 128 | 4 | 21 | 4 | 376 / 412 (20, 0) | 373 / 393 (30, 0) | 2 / 43 (150, 0) | 713 / 822 (1200 / 120) |
| fault | 65 | 314.34 | 147 | 20 | 25 | 171 | 30000 / 30002 (20, 20) | 30001 / 30003 (27, 27) | 30000 / 30001 (123, 107) | — / — (0 / 240) |
| recovery | 3116.88 | 467.44 | 241 | 69 | 45 | 170 | 429 / 30002 (80, 9) | 415 / 30000 (113, 3) | 2 / 29048 (572, 4) | 771 / 22969 (3860 / 360) |

Totals: 170 client timeouts, 0 re-subscribes, 120 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 128 subscriptions created, 91 dropped; cgroup throttled 1236 s.

Live subscriptions on the executor come from its log (created − dropped), an upper bound: a subscribe that fails or is cancelled before it registers logs nothing. Evaluations running = threads named `ad4m-eval-watchdog` (one per running SPARQL evaluation).


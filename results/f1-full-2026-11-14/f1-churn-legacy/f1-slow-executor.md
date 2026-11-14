# f1-slow-executor — PASS

Branch label: `f1-churn-legacy` · duration 780.7 s

**Summary:** pileup from 20× slower; 20×: pileup, recovery none; 100×: no pileup, recovery none

## Environment

| Field | Value |
| --- | --- |
| ad4m commit | unknown |
| Executor version | ad4m 0.13.1-staging.11 |
| Holochain (--run-holochain) | off |
| Machine | 32 CPUs (AMD RYZEN AI MAX+ 395 w/ Radeon 8060S), 122.8 GB RAM, linux-x64, kernel 7.0.0-38-generic |
| Load average start (1/5/15 min) | 6.61 / 7.44 / 6.41 |
| Load average end (1/5/15 min) | 3.93 / 5.38 / 5.48 |
| Host swap used start / end | 7721348 kB / 7721136 kB |
| Run | 1 |
| Started | 2026-11-14T06:31:38.137Z |

# F1: Slow Executor

Executor 4226948b10e11d4227321c9744bf1cc72e5cb580 (0.13.1-staging.11), Holochain off. Space: perspective (no neighbourhood), 30000 seed links.
Clients: 10 app clients (2 live queries + a page query every 10s each), 1 bot(s) with an "everything" query (links); client mode **legacy**, call timeout 30000 ms.
Writes: 4 speakers × 1 line / 1000 ms; auto-processor add+remove every 2000 ms.
Channel switching: each client closes and re-opens its feed live query every ~15s.
Phases: baseline 60s → fault 120s → recovery 180s. Slowdown N× = CPU quota of 1/N of one core on the executor's cgroup.

**Summary:** pileup from 20× slower; 20×: pileup, recovery none; 100×: no pileup, recovery none

| Slowdown | Pileup | Peak CPU % (fault / recovery) | Peak evals running | Peak executor subs | Peak client calls in flight | Timeouts | Re-subscribes | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20× | yes | 104.9 / 2969 | 73 | 96 | 171 | 427 | 0 | not recovered |
| 100× | no | 155.16 / 2843 | 66 | 100 | 176 | 528 | 0 | not recovered |

### 20× slower (CPU quota 5% of one core, cpu.max during fault: 5000 100000)

Load at start: 5.68 / 7.21 / 6.35. Boot 32 ms, perspective answered 2612 ms after, initial subscribes 1565 ms.

**Pileup: YES** — backlog still growing at 39.4/min at the end of the fault, 255 vs baseline 8. **Recovery:** not within the recovery window.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 465 | 319.55 | 131 | 7 | 21 | 7 | 377 / 470 (40, 0) | 373 / 511 (57, 0) | 2 / 43 (300, 0) | 719 / 821 (2400 / 240) |
| fault | 104.9 | 415.17 | 227 | 64 | 47 | 171 | 30000 / 30001 (57, 57) | 30000 / 30002 (87, 87) | 30000 / 30002 (377, 263) | — / — (0 / 480) |
| recovery | 2969 | 450.46 | 238 | 73 | 96 | 170 | 410 / 30001 (135, 10) | 408 / 30000 (203, 6) | 1 / 28024 (1022, 4) | 760 / 33382 (7420 / 720) |

Totals: 427 client timeouts, 0 re-subscribes, 242 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 263 subscriptions created, 175 dropped, 0 subscribes cancelled by the client (each removed without a log line); cgroup throttled 2822 s.

### 100× slower (CPU quota 1% of one core, cpu.max during fault: 1000 100000)

Load at start: 5.57 / 4.79 / 5.35. Boot 83 ms, perspective answered 1877 ms after, initial subscribes 5084 ms.

**Pileup: no** — backlog high (192 vs baseline 8) but flat (-4.2/min): saturated, bounded. **Recovery:** not within the recovery window.

| Phase | Peak CPU % | Peak RSS MB | Peak threads | Peak evals running | Peak executor subs | Peak client calls in flight | Subscribe p50/p99 ms (n, timeouts) | Page query p50/p99 ms (n, timeouts) | Write p50/p99 ms (n, timeouts) | Write→visible p50/p99 ms (n / lines sent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 648 | 300.06 | 128 | 4 | 21 | 4 | 410 / 457 (40, 0) | 409 / 544 (57, 0) | 1 / 43 (300, 0) | 760 / 882 (2400 / 240) |
| fault | 155.16 | 382.09 | 174 | 31 | 22 | 176 | 30000 / 30001 (60, 60) | 30000 / 30001 (86, 86) | 30000 / 30001 (365, 346) | — / — (0 / 480) |
| recovery | 2843 | 446.11 | 222 | 66 | 100 | 171 | 424 / 30001 (137, 14) | 424 / 29495 (201, 2) | 1 / 30000 (1019, 13) | 799 / 12397 (6780 / 720) |

Totals: 528 client timeouts, 0 re-subscribes, 247 channel-switch re-opens, 0 resyncs, 0 lagged notices, 0 error replies; executor log: 268 subscriptions created, 173 dropped, 0 subscribes cancelled by the client (each removed without a log line); cgroup throttled 2461 s.

Live subscriptions on the executor come from its log (created − dropped), an upper bound: a subscribe that fails or is cancelled before it registers logs nothing. Evaluations running = threads named `ad4m-eval-watchdog` (one per running SPARQL evaluation).


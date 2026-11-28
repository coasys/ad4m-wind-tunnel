/**
 * The U1 report: what WE asked the executor for during one call, and which of it was wasted.
 */

import { THRESHOLDS, type Analysis, type RpcCall } from "./rpc-analysis.js";
import type { CaptureIntegrity, TranscriptLine } from "./devtools.js";

export interface ReportInput {
  analysis: Analysis;
  integrity: CaptureIntegrity;
  transcript: TranscriptLine[];
  expectedText: string;
  coverage: number;
  transcriptInUi: boolean;
  steps: { name: string; ok: boolean; ms: number; note?: string }[];
  meta: Record<string, string>;
}

const TOP = THRESHOLDS.topN;

export const ms = (n?: number) =>
  n === undefined ? "—" : n >= 10000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;

export const bytes = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`;

/** A table cell: one line, no pipes, bounded. */
export function cell(s: string | undefined, max = 90): string {
  if (!s) return "—";
  const one = s.replace(/\s+/g, " ").replace(/\|/g, "\\|");
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const code = (s: string | undefined, max = 90) => (s ? `\`${cell(s, max).replace(/`/g, "'")}\`` : "—");
const ok = (b: boolean) => (b ? "✅" : "❌");

function table(head: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["_None._", ""];
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`), ""];
}

const sites = (list: string[]) => (list.length ? list.slice(0, 2).map((s) => code(s, 120)).join("<br>") : "—");

function callRow(c: RpcCall, phase: string): string[] {
  return [
    code(c.method, 60),
    phase,
    ms(c.durationMs),
    bytes(c.requestBytes),
    bytes(c.responseBytes),
    code(c.paramsPreview, 70),
    c.callSite ? code(c.callSite, 110) : c.channel === "http" ? "HTTP" : "—",
  ];
}

export function renderReport(input: ReportInput, phaseOf: (t: number) => string): string {
  const { analysis: a, integrity: i, transcript } = input;
  const t = a.totals;
  const lines: string[] = [];
  const push = (...xs: string[]) => lines.push(...xs);

  push("# U1 — WE call + transcription: RPC report", "");
  push(Object.entries(input.meta).map(([k, v]) => `**${k}:** ${v}`).join(" · "), "");

  const captureOk = i.devtoolsInstalled && i.tappedRequests === i.wireRequests;
  push("## Verdict", "");
  push(
    ...table(
      ["Check", "Result"],
      [
        [
          "Scenario steps",
          `${ok(input.steps.every((s) => s.ok))} ${input.steps.filter((s) => s.ok).length}/${input.steps.length} completed`,
        ],
        [
          "Transcription (socket)",
          `${ok(input.coverage >= 0.8)} ${transcript.length} line(s); ${Math.round(input.coverage * 100)}% of "${cell(input.expectedText, 60)}"`,
        ],
        ["Transcription (WE's transcript panel)", `${ok(input.transcriptInUi)} ${input.transcriptInUi ? "shown" : "not shown"}`],
        [
          "Capture integrity",
          `${ok(captureOk)} devtools logged ${i.tappedRequests} requests, the wire carried ${i.wireRequests}; ${i.devtoolsOwnRequests} were the bridge's own (excluded); ${i.httpRequests} HTTP requests via the browser's network log`,
        ],
      ],
    ),
  );

  push("## Steps", "");
  push(...table(["Step", "Result", "Time", "Note"], input.steps.map((s) => [s.name, ok(s.ok), ms(s.ms), cell(s.note, 120)])));

  push("## Summary", "");
  push(
    ...table(
      ["Metric", "Value"],
      [
        ["RPC calls", `${t.calls} (${t.wsCalls} WebSocket, ${t.httpCalls} HTTP)`],
        ["Errors", String(t.errors)],
        ["Bytes up / down", `${bytes(t.requestBytes)} / ${bytes(t.responseBytes)}`],
        ["Push events", `${t.events} (${bytes(t.eventBytes)})`],
        [
          `Push events delivered twice within ${THRESHOLDS.duplicateEventWindowMs / 1000} s`,
          `${t.duplicateEvents} (${a.events.reduce((n, e) => n + e.crossSocketDuplicates, 0)} of them on a second socket; the page opened ${i.sockets} executor socket(s))`,
        ],
        ["Redundant reads — same call, same answer as the previous one", String(t.redundantReads)],
        ["Coalescable — identical call already in flight", String(t.coalescable)],
        [`Identical writes within ${THRESHOLDS.identicalWriteWindowMs / 1000} s`, String(t.identicalWrites)],
        ["Polling loops", String(a.polling.length)],
        ["Fan-out bursts (N+1)", String(a.fanOut.length)],
        [
          "Subscriptions",
          `${a.subscriptions.total} opened, ${a.subscriptions.activeAtEnd} live at the end; ${a.subscriptions.unchangedUpdates}/${a.subscriptions.updates} pushes carried an unchanged result`,
        ],
      ],
    ),
  );

  push("## By phase", "");
  push(
    ...table(
      ["Phase", "Wall", "Calls", "Methods", "Σ latency", "Up", "Down", "Events"],
      a.phases.map((p) => [
        p.name,
        ms(p.wallMs),
        String(p.calls),
        String(p.methods),
        ms(p.sumMs),
        bytes(p.requestBytes),
        bytes(p.responseBytes),
        `${p.events} (${bytes(p.eventBytes)})`,
      ]),
    ),
  );

  push("## Redundant calls", "");
  push("### Same call, same answer", "");
  push(
    "Identical method and params. *Unchanged* counts reads whose answer matched the previous one — a cache would have served them. *In flight* counts calls made while an identical one was still pending — sharing that promise would have saved them.",
    "",
  );
  push(
    ...table(
      ["Method", "Calls", "Unchanged", "In flight", "Wasted", "Params", "Call sites", "Phases"],
      a.duplicates
        .filter((g) => g.unchangedRepeats + g.concurrentRepeats > 0)
        .slice(0, TOP)
        .map((g) => [
          code(g.method, 50),
          String(g.calls),
          String(g.unchangedRepeats),
          String(g.concurrentRepeats),
          `${ms(g.wastedMs)} / ${bytes(g.wastedBytes)}`,
          code(g.paramsPreview, 60),
          sites(g.callSites),
          g.phases.join(", "),
        ]),
    ),
  );

  push("### Polling loops", "");
  push(
    `The same call repeated at a steady interval (≥ ${THRESHOLDS.pollingMinCalls} calls, period ≥ ${THRESHOLDS.pollingMinPeriodMs / 1000} s, jitter ≤ ${THRESHOLDS.pollingMaxCv * 100}%).`,
    "",
  );
  push(
    ...table(
      ["Method", "Calls", "Period", "Unchanged answers", "Params", "Call sites"],
      a.polling.map((p) => [
        code(p.method, 50),
        String(p.calls),
        ms(p.periodMs),
        `${Math.round(p.unchangedRatio * 100)}%`,
        code(p.paramsPreview, 60),
        sites(p.callSites),
      ]),
    ),
  );

  push("### Fan-out bursts (N+1)", "");
  push(
    `≥ ${THRESHOLDS.burstMinCalls} calls to one method, ≥ ${THRESHOLDS.burstMinDistinct} distinct params, each within ${THRESHOLDS.burstGapMs} ms of the last — usually a loop issuing one request per item.`,
    "",
  );
  push(
    ...table(
      ["Method", "Calls", "Distinct", "Window", "Σ latency", "Varying params", "Phase", "Call sites"],
      a.fanOut.slice(0, TOP).map((b) => [
        code(b.method, 50),
        String(b.calls),
        String(b.distinctParams),
        ms(b.windowMs),
        ms(b.totalMs),
        b.varyingKeys.length ? b.varyingKeys.map((k) => code(k)).join(", ") : "—",
        b.phase,
        sites(b.callSites),
      ]),
    ),
  );

  push("### Identical writes", "");
  push(
    `The same write with the same params within ${THRESHOLDS.identicalWriteWindowMs / 1000} s. Where every answer differs, the executor treated each as a new operation (a new batch, a new stream) — then the question is whether one would do, not whether one is a double submit.`,
    "",
  );
  push(
    ...table(
      ["Method", "Calls", "Distinct answers", "Closest pair", "Params", "Call sites"],
      a.identicalWrites
        .slice(0, TOP)
        .map((g) => [
          code(g.method, 50),
          String(g.calls),
          String(g.distinctAnswers),
          ms(g.minIntervalMs),
          code(g.paramsPreview, 70),
          sites(g.callSites),
        ]),
    ),
  );

  push("### Subscriptions left running twice", "");
  push(
    ...table(
      ["Model", "Live copies", "Query"],
      a.subscriptions.duplicateActive.slice(0, TOP).map((d) => [code(d.modelName, 40), String(d.active), code(d.query, 100)]),
    ),
  );

  push("## Failed calls", "");
  push(
    ...table(
      ["Method", "Calls", "Error", "Phases", "Call sites"],
      a.errors.map((e) => [code(e.method, 50), String(e.calls), cell(e.message, 120), e.phases.join(", "), sites(e.callSites)]),
    ),
  );

  push("## Expensive calls", "");
  push("### Slowest single calls", "");
  push(
    ...table(
      ["Method", "Phase", "Latency", "Up", "Down", "Params", "Call site"],
      a.slowest.map((c) => callRow(c, phaseOf(c.start))),
    ),
  );
  push("### Heaviest methods (total latency)", "");
  push(
    ...table(
      ["Method", "Kind", "Calls", "Σ latency", "p50", "p95", "Max", "Down"],
      a.methods.slice(0, TOP).map((m) => [
        code(m.method, 50),
        m.kind,
        String(m.calls),
        ms(m.totalMs),
        ms(m.p50Ms),
        ms(m.p95Ms),
        ms(m.maxMs),
        bytes(m.responseBytes),
      ]),
    ),
  );
  push("### Largest payloads", "");
  push(
    ...table(
      ["Method", "Phase", "Latency", "Up", "Down", "Params", "Call site"],
      a.largest.map((c) => callRow(c, phaseOf(c.start))),
    ),
  );
  push("### Push events", "");
  push(
    "Messages the executor pushed without being asked. *Repeats* are byte-identical copies of a message received less than a second before — on the same socket, the executor sent it twice; on a second socket, the page subscribed twice.",
    "",
  );
  push(
    ...table(
      ["Event", "Count", "Bytes", "Per second", "Repeats"],
      a.events.map((e) => [
        code(e.type, 50),
        String(e.count),
        bytes(e.bytes),
        e.perSecond.toFixed(2),
        e.duplicates
          ? `${e.duplicates} (${bytes(e.duplicateBytes)})${e.crossSocketDuplicates ? `, ${e.crossSocketDuplicates} on a second socket` : ""}`
          : "0",
      ]),
    ),
  );

  push("## All methods", "");
  push(
    ...table(
      ["Method", "Kind", "Calls", "Errors", "Σ latency", "p50", "p95", "Max", "Up", "Down"],
      a.methods.map((m) => [
        code(m.method, 60),
        m.kind,
        String(m.calls),
        String(m.errors),
        ms(m.totalMs),
        ms(m.p50Ms),
        ms(m.p95Ms),
        ms(m.maxMs),
        bytes(m.requestBytes),
        bytes(m.responseBytes),
      ]),
    ),
  );

  push("## Transcript", "");
  push(
    ...(transcript.length
      ? transcript
          .slice(0, 20)
          .map((l) => `- ${new Date(l.at).toISOString().slice(11, 23)} · stream \`${(l.streamId ?? "?").slice(0, 8)}\` — ${cell(l.text, 200)}`)
      : ["_Nothing was transcribed._"]),
    "",
  );

  push("## Reading this report", "");
  push(
    "- **Latency** is the round trip WE observed: request sent to answer received.",
    "- WebSocket calls come from the ad4m-devtools bridge injected into the page. HTTP calls (the SDK sends transcription audio over HTTP) come from the browser's network log, which carries no JS stack — hence no call site.",
    "- **Kind** (read / write / subscribe) is inferred from the method name; only reads count as redundant when repeated.",
    "- **Call sites** are the first WE frames on the captured stack, mapped through source maps — innermost first, `←` meaning *called from*.",
    "- Previews redact keys that look like secrets. Everything ran against a throwaway local executor and test user.",
    "",
  );
  return lines.join("\n");
}

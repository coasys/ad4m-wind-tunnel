#!/usr/bin/env node
/**
 * Deterministic mock LLM for the agent-harness wind tunnel.
 *
 * Speaks OpenAI chat-completions and Anthropic Messages — streaming (SSE) and
 * non-streaming — so OpenClaw, Hermes, and Sovereign can all point their model
 * provider here. It returns a scripted sequence of tool calls (or a final text),
 * which makes every non-model failure reproducible — we prove the plumbing before
 * a real model ever runs.
 *
 * Sovereign runs on the Claude Agent SDK, which always requests Anthropic
 * `/v1/messages` with `stream:true` and expects the full SSE event sequence
 * (message_start → content_block_* → message_delta → message_stop) with
 * `tool_use` blocks — hence the streaming support here.
 *
 * Config via env:
 *   PORT             — listen port (default 8080)
 *   MOCK_LLM_LOG=1   — log each incoming request to stderr (learn a harness's contract)
 *   MOCK_LLM_SCRIPT  — JSON array of steps; each step is {tool_calls:[{name,arguments}]} or {text:"..."}
 *
 * The script advances one step per chat/messages request; when it runs out it
 * returns a final "done" text. A fresh instance per scenario keeps it deterministic.
 *
 * ── Interpretation mode (I-series) ──
 * The generic-LLM-interpretation feature (`perspective.runInterpretation` /
 * `addAutoProcessor`) prompts a plain chat completion — no `tools` array — whose
 * user turn carries the JSON `{"classes":[...],"transcript":[...]}` payload
 * `build_interpretation_input` assembles (see ad4m-interp's
 * `rust-executor/src/perspectives/interpretation/prompt.rs`). This mock recognises
 * that shape (no `tools`, body containing both `"classes"` and `"transcript"`) and
 * answers from a **content-keyed rule table** instead of the tool-call script, so
 * interpretation calls never consume/interfere with a scripted A-series step:
 *
 *   MOCK_LLM_INTERP_RULES — JSON array of rules, checked in order:
 *     { "label"?: string, "match": string | string[], "response": any }
 *   Every `match` substring must appear in the raw request body (an AND over the
 *   array form); the first matching rule sends its `response` back as the
 *   assistant's plain-text reply. `response` can hold the JSON value to return
 *   (auto-stringified into the exact array shape `interpretation/parse.rs`
 *   expects) OR a raw string sent verbatim — useful for proving the parser's
 *   noise-stripping (code fences, `<think>` blocks) end to end. When no rule
 *   matches, the mock returns `"[]"` (a valid, empty extraction — never the
 *   tool-script's "ok" filler, which fails to parse as interpretation JSON and
 *   would burn the executor's 5-attempt retry budget on every unmatched call).
 *
 * Rules can also load/replace at RUNTIME (a create call's response often needs
 * to embed a base URI the executor mints only after the first call returns,
 * which this process cannot know upfront):
 *   POST /interp-rules  { "rules": [...] }  -> replaces the table, {ok:true,count}
 *   GET  /interp-rules                      -> current table (debugging)
 *
 * This design stays fully additive: the mock recognises an interpretation-shaped
 * call only when the request carries NO `tools` array, so every existing
 * A-series scripted-tool-call flow continues to work unchanged.
 */
import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const LOG = process.env.MOCK_LLM_LOG === "1";
// Optional content gate: when set, the scripted plan (tool_calls) is served only
// on turns whose request body contains this substring; every other tool-bearing
// turn (e.g. a harness's boot/auto-start turn) gets a benign reply and does NOT
// consume a step. Keeps a scripted tool_call from being eaten by an unrelated turn.
const TRIGGER = process.env.MOCK_LLM_TRIGGER || "";
// Optional perceive marker: when set, each logged request records has_mark=<bool>
// (does the request body carry this substring). A5 sets it to a distinctive
// transcript phrase so a scenario can assert the transcript content reached the
// act-capable turn — i.e. the agent perceived the transcript. Additive; A4's
// `has_mention=... has_presence_reply_tool=...` log fields stay intact.
const MARK = process.env.MOCK_LLM_MARK || "";

let script = [];
try {
  if (process.env.MOCK_LLM_SCRIPT) script = JSON.parse(process.env.MOCK_LLM_SCRIPT);
} catch (e) {
  console.error("[mock-llm] bad MOCK_LLM_SCRIPT:", e.message);
}
let step = 0;

// ── Interpretation rule table (content-keyed, independent of `script`/`step`) ──
let interpRules = [];
try {
  if (process.env.MOCK_LLM_INTERP_RULES) interpRules = JSON.parse(process.env.MOCK_LLM_INTERP_RULES);
} catch (e) {
  console.error("[mock-llm] bad MOCK_LLM_INTERP_RULES:", e.message);
}
let interpCalls = 0;

function nextStep() {
  const s = step < script.length ? script[step] : { text: "done" };
  step += 1;
  if (LOG) {
    const desc = s.tool_calls ? "tools:" + s.tool_calls.map((t) => t.name).join("+") : "text";
    console.error(`[mock-llm] advance step ${step - 1} -> ${desc}`);
  }
  return s;
}

/** The text the model actually sees, reconstructed from the parsed request.
 *
 * `build_interpretation_input`'s `{"classes":...,"transcript":...}` JSON rides
 * *inside* a chat message's `content` field, so in the raw HTTP body its inner
 * quotes are escaped (`\"classes\"`) — a literal `"classes"` never appears at
 * the top level. Detecting/matching against the raw body therefore misses every
 * interpretation call. Join the parsed message contents (OpenAI `messages[]`,
 * plus an Anthropic top-level `system` string) so downstream checks see the
 * real, unescaped payload; fall back to the raw body for shapes we can't parse. */
function promptHaystack(payload, body) {
  const parts = [];
  if (typeof payload?.system === "string") parts.push(payload.system);
  if (Array.isArray(payload?.messages)) {
    for (const m of payload.messages) {
      if (typeof m?.content === "string") parts.push(m.content);
      else if (Array.isArray(m?.content)) {
        for (const c of m.content) if (typeof c?.text === "string") parts.push(c.text);
      }
    }
  }
  return parts.length ? parts.join("\n") : body;
}

/** A request counts as interpretation-shaped when it carries no tool-call
 * surface (a plain completion, not an agent turn) and a message content carries
 * the `build_interpretation_input` JSON — recognised by its two load-bearing
 * top-level keys, checked against the unescaped haystack. */
function looksLikeInterpretation(haystack, hasTools) {
  return !hasTools && haystack.includes('"classes"') && haystack.includes('"transcript"');
}

/** First rule whose `match` substring(s) all appear in the prompt haystack;
 * `undefined` when none match (caller falls back to an empty-array extraction). */
function matchInterpRule(haystack) {
  return interpRules.find((r) => {
    const needles = Array.isArray(r.match) ? r.match : [r.match];
    return needles.length > 0 && needles.every((n) => haystack.includes(n));
  });
}

function interpretationReply(haystack) {
  interpCalls += 1;
  const rule = matchInterpRule(haystack);
  if (rule) {
    const text = typeof rule.response === "string" ? rule.response : JSON.stringify(rule.response);
    if (LOG) console.error(`[mock-llm] interpretation call ${interpCalls} -> rule "${rule.label || (Array.isArray(rule.match) ? rule.match.join("+") : rule.match)}"`);
    return { text };
  }
  if (LOG) console.error(`[mock-llm] interpretation call ${interpCalls} -> no rule matched, returning []`);
  return { text: "[]" };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}
function sseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function sseData(res, data) {
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

// ── Anthropic Messages (streaming SSE) ──
function anthropicStream(res, s) {
  const id = `msg_mock_${step}`;
  sseHead(res);
  sseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "mock-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  if (s.tool_calls) {
    s.tool_calls.forEach((t, i) => {
      sseEvent(res, "content_block_start", {
        type: "content_block_start",
        index: i,
        content_block: { type: "tool_use", id: `toolu_${step}_${i}`, name: t.name, input: {} },
      });
      sseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(t.arguments || {}) },
      });
      sseEvent(res, "content_block_stop", { type: "content_block_stop", index: i });
    });
    sseEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 0 },
    });
  } else {
    sseEvent(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    sseEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: s.text || "done" },
    });
    sseEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sseEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    });
  }
  sseEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

function anthropicJson(res, s) {
  let content;
  let stop_reason;
  if (s.tool_calls) {
    content = s.tool_calls.map((t, i) => ({
      type: "tool_use",
      id: `toolu_${step}_${i}`,
      name: t.name,
      input: t.arguments || {},
    }));
    stop_reason = "tool_use";
  } else {
    content = [{ type: "text", text: s.text || "done" }];
    stop_reason = "end_turn";
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `msg_mock_${step}`,
      type: "message",
      role: "assistant",
      model: "mock-model",
      content,
      stop_reason,
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  );
}

// ── OpenAI chat-completions (streaming SSE) ──
function openaiStream(res, s) {
  const id = `chatcmpl-mock-${step}`;
  const base = { id, object: "chat.completion.chunk", created: 0, model: "mock-model" };
  sseHead(res);
  if (s.tool_calls) {
    sseData(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] });
    s.tool_calls.forEach((t, i) => {
      sseData(res, {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: i,
                  id: `call_${step}_${i}`,
                  type: "function",
                  function: { name: t.name, arguments: JSON.stringify(t.arguments || {}) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    });
    sseData(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    sseData(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: s.text || "done" }, finish_reason: null }] });
    sseData(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  sseData(res, "[DONE]");
  res.end();
}

function openaiJson(res, s) {
  let message;
  if (s.tool_calls) {
    message = {
      role: "assistant",
      content: null,
      tool_calls: s.tool_calls.map((t, i) => ({
        id: `call_${step}_${i}`,
        type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.arguments || {}) },
      })),
    };
  } else {
    message = { role: "assistant", content: s.text || "done" };
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `chatcmpl-mock-${step}`,
      object: "chat.completion",
      created: 0,
      model: "mock-model",
      choices: [{ index: 0, message, finish_reason: s.tool_calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  );
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "";

  if (req.method === "GET" && (url === "/health" || url === "/")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", step, scriptLen: script.length, interpCalls, interpRules: interpRules.length }));
  }
  if (req.method === "GET" && url.includes("models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "windtunnel" }] }),
    );
  }

  // ── Interpretation rule control-plane (runtime-settable; a create call's
  // response needs a base URI the executor only mints after the FIRST call
  // returns, so drivers push the next rule between `runInterpretation` calls). ──
  if (url === "/interp-rules") {
    if (req.method === "POST") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "bad JSON", detail: e.message }));
      }
      interpRules = Array.isArray(parsed) ? parsed : parsed.rules || [];
      if (LOG) console.error(`[mock-llm] interp-rules replaced: ${interpRules.length} rule(s)`);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, count: interpRules.length }));
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ rules: interpRules, interpCalls }));
    }
  }

  const body = await readBody(req);
  if (LOG)
    console.error(
      `\n=== ${req.method} ${url} === has_mention=${body.includes("mentioned you")} has_presence_reply_tool=${body.includes("presence_reply_ad4m")} has_mark=${MARK ? body.includes(MARK) : false}\n${body.slice(0, 4000)}`,
    );
  let payload = {};
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    /* non-JSON body */
  }
  const wantsStream = payload?.stream === true || (req.headers.accept || "").includes("text/event-stream");
  const hasTools = Array.isArray(payload?.tools) && payload.tools.length > 0;
  const structured =
    payload?.output_config?.format?.type === "json_schema" || payload?.response_format?.type === "json_schema";

  // Only advance the scripted plan on real, tool-capable agent turns. The SDKs
  // make auxiliary model calls around a turn (title generation, structured-output
  // probes, tool-less summaries); those get a benign reply and do NOT consume a
  // step — otherwise a title call would eat the turn's scripted tool_call.
  const triggered = !TRIGGER || body.includes(TRIGGER);
  const haystack = promptHaystack(payload, body);
  let s;
  if (looksLikeInterpretation(haystack, hasTools)) {
    // Generic-LLM-interpretation call (no tools, `{"classes":...,"transcript":...}`
    // in a message content) — answer from the content-keyed rule table; never
    // touches `script`/`step`.
    s = interpretationReply(haystack);
  } else {
    s = hasTools && triggered ? nextStep() : { text: structured ? JSON.stringify({ title: "session" }) : "ok" };
  }

  if (url.includes("/chat/completions")) {
    return wantsStream ? openaiStream(res, s) : openaiJson(res, s);
  }
  if (url.includes("/messages")) {
    return wantsStream ? anthropicStream(res, s) : anthropicJson(res, s);
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found", url }));
});

server.listen(PORT, () =>
  console.error(
    `[mock-llm] listening on :${PORT} (script steps: ${script.length}, interp rules: ${interpRules.length}, LOG=${LOG})`,
  ),
);

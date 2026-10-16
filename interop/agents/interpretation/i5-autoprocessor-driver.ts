/**
 * I5 — neighbourhood auto-processor, single executor.
 *
 * Registers a processor on a "channel" scope query, injects a burst of
 * messages from two distinct authors, and asserts the executor's own watch
 * loop — not a manual `runInterpretation` call — gathers the transcript,
 * debounces, claims the batch, runs the LLM, and writes exactly one typed
 * instance. Mirrors `auto-processor.test.ts` (WS + real LLM) with the mock in
 * place of Ollama, and additionally waits past the first `processed` signal to
 * assert no double-processing / no duplicate instance follows.
 *
 * Env: WS_HOST/WS_PORT (executor WS-RPC), ADMIN (token), MOCK_HOST/MOCK_PORT.
 */
import { AutoProcessorEvent, InterpClient, registerInterpretationModel, sleep, waitForExecutorHealth, waitForMockHealth } from "./interp-client.js";
import { classUri, registerModels } from "./models.js";
import { setInterpRules } from "./mock-control.js";
import { assertTrue, assertEqual, assertDefined } from "./assert.js";

const WS_HOST = process.env.WS_HOST || "127.0.0.1";
const WS_PORT = Number(process.env.WS_PORT || 0);
const ADMIN = process.env.ADMIN || "windtunnel-admin";
const MOCK_HOST = process.env.MOCK_HOST || "127.0.0.1";
const MOCK_PORT = Number(process.env.MOCK_PORT || 0);
// Executor-facing mock URL (docker-network name), distinct from the host-published
// loopback the driver uses for control-plane calls. See registerInterpretationModel.
const MOCK_INTERNAL_URL = process.env.MOCK_INTERNAL_URL || `http://${MOCK_HOST}:${MOCK_PORT}/v1`;
const BASE_PREFIX = "wt://i5/";
const PROCESSOR_ID = "i5-channel";

// Matches the shape `auto-processor.test.ts` uses: a plain `ns://body` /
// `ns://author` message pair, scanned in message order.
const SCOPE_QUERY = "SELECT ?speaker ?text WHERE { ?m <ns://body> ?text . ?m <ns://author> ?speaker . } ORDER BY ?m";

function withTimeout<T>(pr: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([pr, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

async function main() {
  assertTrue(!!WS_PORT && !!MOCK_PORT, "the caller must set WS_PORT and MOCK_PORT");
  await waitForExecutorHealth(WS_HOST, WS_PORT);
  await waitForMockHealth(MOCK_HOST, MOCK_PORT);

  const client = new InterpClient(WS_HOST, WS_PORT, ADMIN);
  await client.connect();
  console.log("[i5] connected to executor");

  const modelId = await registerInterpretationModel(client, MOCK_INTERNAL_URL);
  console.log(`[i5] registered interpretation model ${modelId}`);

  const persp = await client.createPerspective("i5-autoprocessor");
  const uuid = persp.uuid;
  console.log(`[i5] perspective ${uuid}`);

  await registerModels(client, uuid, ["WtThread"]);

  // The canned reply groups both turns into one WtThread — keyed on marker
  // words unique to this scenario's two messages.
  await setInterpRules(MOCK_HOST, MOCK_PORT, [
    {
      label: "group-webhook-outage-thread",
      match: ["webhook retries", "payments queue"],
      response: [{ class: "WtThread", name: "Webhook retry failures", summary: "The team discussed dropped webhook retries during a payments outage and the lack of a replay path." }],
    },
  ]);

  const events: AutoProcessorEvent[] = [];
  let resolveProcessed!: (ev: AutoProcessorEvent) => void;
  const processed = new Promise<AutoProcessorEvent>((res) => {
    resolveProcessed = res;
  });
  let processedCount = 0;
  client.onAutoProcessorEvent((ev) => {
    if (ev.perspectiveUuid !== uuid || ev.processorId !== PROCESSOR_ID) return;
    events.push(ev);
    if (ev.step === "processed") {
      processedCount += 1;
      if (processedCount === 1) resolveProcessed(ev);
    }
  });

  await client.addAutoProcessor(uuid, {
    processorId: PROCESSOR_ID,
    sourceScopeQuery: SCOPE_QUERY,
    basePrefix: BASE_PREFIX,
    interpretationClasses: [classUri("WtThread")],
    debounceMs: 50,
    batchMin: 2,
    batchMax: 32,
    claimTtlMs: 60_000,
  });
  console.log(`[i5] registered auto-processor '${PROCESSOR_ID}' on the channel scope query`);

  // Inject a burst from two distinct authors — no manual runInterpretation.
  const msgs: [string, string, string][] = [
    ["msg://i5/c1", "did:key:ana", "Our webhook retries keep dropping during payment outages - we lose the failed events."],
    ["msg://i5/c2", "did:key:ben", "Right, the payments queue has no way to replay what got dropped last time."],
  ];
  for (const [uri, author, text] of msgs) {
    await client.addLink(uuid, { source: uri, predicate: "ns://body", target: `literal:string:${text}` }, "local");
    await client.addLink(uuid, { source: uri, predicate: "ns://author", target: author }, "local");
  }
  console.log("[i5] posted a 2-message burst from two distinct authors");

  const ev = await withTimeout(processed, 120_000, "auto-processor did not signal 'processed' within 120s");
  console.log(`[i5] processed signal: bases=${JSON.stringify(ev.bases)} agentDid=${ev.agentDid || "<none>"}`);
  assertTrue(ev.bases.length > 0, "the 'processed' signal must carry written bases");
  const steps = events.map((e) => e.step);
  assertTrue(steps.includes("batchReady"), `expected a 'batchReady' step, got ${JSON.stringify(steps)}`);
  assertTrue(steps.includes("runningInterpretation"), `expected a 'runningInterpretation' step, got ${JSON.stringify(steps)}`);

  let rows = (await client.modelQuery(uuid, "WtThread", {})).instances;
  assertEqual(rows.length, 1, "exactly one WtThread must exist after the pass");
  assertEqual(rows[0].name, "Webhook retry failures", "WtThread.name");
  assertTrue(typeof rows[0].summary === "string" && rows[0].summary.length > 0, "the pass must populate WtThread.summary");
  console.log("[i5] ok — the watch loop gathered the transcript, ran the LLM, and wrote exactly one typed instance");

  // No double-processing: wait past the first 'processed' signal and confirm
  // no second pass / duplicate instance follows for the SAME batch.
  await sleep(10_000);
  assertEqual(processedCount, 1, `expected exactly 1 'processed' signal total, got ${processedCount}`);
  rows = (await client.modelQuery(uuid, "WtThread", {})).instances;
  assertEqual(rows.length, 1, "no duplicate WtThread must appear after the grace period");

  console.log(
    "[i5] PASS — addAutoProcessor ran exactly one batch pass over a 2-author burst; typed instance landed; no double-processing after the grace period",
  );
  client.close();
}

main().catch((e) => {
  console.error(`[i5] FAIL — ${e?.stack || e}`);
  process.exit(1);
});

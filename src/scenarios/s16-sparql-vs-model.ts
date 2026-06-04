/**
 * S16: SPARQL vs Ad4mModel comparison
 *
 * Side-by-side benchmark of raw `perspective.querySparql` vs
 * `Ad4mModel.findAll` (via `perspective.modelQuery`) on identical
 * data. Drives the per-site convert-vs-keep decisions in
 * flux's `docs/sparql-to-ad4m-model-migration.md`.
 *
 * Seeds a Flux-shaped community graph (channels → messages, plus
 * SemanticRelationship reifications linking messages to embeddings
 * and topics). Registers minimal SHACL subject classes via
 * `perspective.addSdna` so `modelQuery` resolves. Then runs each
 * candidate query in two shapes against the same perspective and
 * emits per-scale percentiles.
 *
 * Designed to surface three things:
 *   1. The per-call overhead of the model_query path vs raw SPARQL.
 *   2. Whether `findAll({ where, limit })` actually exploits the
 *      LIMIT at the SPARQL/Oxigraph layer or scans linearly.
 *   3. Whether `include: { hasOne }` saves a round-trip in practice
 *      for the polymorphic-on-same-predicate case Flux uses for SRs.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { InstrumentedClient } from "../client.js";

// ----- Predicates / entry types (subset from S8 reused intentionally) -----

const P = {
  ENTRY_TYPE: "flux://entry_type",
  HAS_CHILD: "ad4m://has_child",
  BODY: "flux://body",
  AUTHOR: "ad4m://ontology/author",
  TIMESTAMP: "ad4m://ontology/timestamp",
  HAS_EXPRESSION: "flux://has_expression",
  HAS_TAG: "flux://has_tag",
  HAS_RELEVANCE: "flux://has_relevance",
  EMBEDDING: "flux://embedding",
  EMBEDDING_MODEL: "flux://model",
  TOPIC: "flux://topic",
};

const T = {
  Channel: "flux://has_channel",
  Message: "flux://has_message",
  Embedding: "flux://has_embedding",
  Topic: "flux://has_topic",
  SemanticRelationship: "flux://has_semantic_relationship",
};

// ----- SHACL subject-class definitions -----
//
// Mirrors @Model decorators in flux's packages/api/src/{embedding,topic,
// semantic-relationship}. Inline here so this scenario doesn't need to
// cross-import flux's TypeScript source.

const SHACL_EMBEDDING = JSON.stringify({
  target_class: "flux://Embedding",
  properties: [
    { path: P.ENTRY_TYPE, name: "type", datatype: "xsd://string", required: true, flag: true, initial_value: T.Embedding },
    { path: P.EMBEDDING, name: "embedding", datatype: "xsd://string" },
    { path: P.EMBEDDING_MODEL, name: "model", datatype: "xsd://string", resolve_language: "literal" },
  ],
  relations: [],
});

const SHACL_TOPIC = JSON.stringify({
  target_class: "flux://Topic",
  properties: [
    { path: P.ENTRY_TYPE, name: "type", datatype: "xsd://string", required: true, flag: true, initial_value: T.Topic },
    { path: P.TOPIC, name: "topic", datatype: "xsd://string", resolve_language: "literal" },
  ],
  relations: [],
});

const SHACL_MESSAGE = JSON.stringify({
  target_class: "flux://Message",
  properties: [
    { path: P.ENTRY_TYPE, name: "type", datatype: "xsd://string", required: true, flag: true, initial_value: T.Message },
    { path: P.BODY, name: "body", datatype: "xsd://string" },
    { path: P.AUTHOR, name: "author", datatype: "xsd://string" },
    { path: P.TIMESTAMP, name: "timestamp", datatype: "xsd://string" },
  ],
  relations: [],
});

const SHACL_SR = JSON.stringify({
  target_class: "flux://SemanticRelationship",
  properties: [
    { path: P.ENTRY_TYPE, name: "type", datatype: "xsd://string", required: true, flag: true, initial_value: T.SemanticRelationship },
    { path: P.HAS_EXPRESSION, name: "expression", datatype: "xsd://string" },
    { path: P.HAS_TAG, name: "tag", datatype: "xsd://string" },
    { path: P.HAS_RELEVANCE, name: "relevance", datatype: "xsd://integer", resolve_language: "literal" },
  ],
  relations: [
    // Two @HasOne on the same predicate — the conformance filter on the
    // target class's @Flag is supposed to discriminate. The bench
    // surfaces whether the executor actually honours this.
    { name: "embeddingTag", predicate: P.HAS_TAG, target_class_name: "Embedding", kind: "hasOne" },
    { name: "topicTag", predicate: P.HAS_TAG, target_class_name: "Topic", kind: "hasOne" },
  ],
});

// ----- Tiers -----

interface Tier {
  name: string;
  items: number; // messages = embeddings = SRs
  topics: number;
}

const TIERS: Tier[] = [
  { name: "small", items: 100, topics: 10 },
  { name: "medium", items: 1000, topics: 30 },
];

// ----- Stats helpers -----

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
}

function statsOf(latencies: number[]) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    runs: sorted.length,
    avg: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
    p50: pct(sorted, 0.5),
    p95: pct(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function lit(s: string): string {
  return `literal://string:${encodeURIComponent(s)}`;
}

// ----- Seeding -----

interface Seeded {
  channelId: string;
  messageIds: string[];
  embeddingIds: string[];
  srIds: string[];
  topicIds: string[];
  totalLinks: number;
}

async function seedGraph(client: InstrumentedClient, uuid: string, tier: Tier): Promise<Seeded> {
  const channelId = `ad4m://s16-channel`;
  const messageIds: string[] = [];
  const embeddingIds: string[] = [];
  const srIds: string[] = [];
  const topicIds: string[] = [];
  const links: { source: string; predicate: string; target: string }[] = [];

  links.push({ source: channelId, predicate: P.ENTRY_TYPE, target: T.Channel });

  for (let i = 0; i < tier.items; i++) {
    const m = `ad4m://msg-${i}`;
    const e = `ad4m://embed-${i}`;
    const s = `ad4m://sr-${i}`;
    messageIds.push(m);
    embeddingIds.push(e);
    srIds.push(s);

    // Channel → message
    links.push({ source: channelId, predicate: P.HAS_CHILD, target: m });
    // Message
    links.push({ source: m, predicate: P.ENTRY_TYPE, target: T.Message });
    links.push({ source: m, predicate: P.BODY, target: lit(`body ${i}`) });
    links.push({ source: m, predicate: P.AUTHOR, target: `did:key:author-${i % 10}` });
    links.push({ source: m, predicate: P.TIMESTAMP, target: lit(new Date(Date.now() - (tier.items - i) * 1000).toISOString()) });
    // Embedding
    links.push({ source: e, predicate: P.ENTRY_TYPE, target: T.Embedding });
    links.push({ source: e, predicate: P.EMBEDDING, target: lit(`vec://${i}`) });
    // SR linking message → embedding
    links.push({ source: s, predicate: P.ENTRY_TYPE, target: T.SemanticRelationship });
    links.push({ source: s, predicate: P.HAS_EXPRESSION, target: m });
    links.push({ source: s, predicate: P.HAS_TAG, target: e });
  }

  for (let t = 0; t < tier.topics; t++) {
    const tid = `ad4m://topic-${t}`;
    topicIds.push(tid);
    links.push({ source: tid, predicate: P.ENTRY_TYPE, target: T.Topic });
    links.push({ source: tid, predicate: P.TOPIC, target: lit(`topic ${t}`) });
    // Tag a few messages to this topic so SR.topicTag has something to find
    const targetMsg = messageIds[t % messageIds.length];
    const srTop = `ad4m://sr-topic-${t}`;
    links.push({ source: srTop, predicate: P.ENTRY_TYPE, target: T.SemanticRelationship });
    links.push({ source: srTop, predicate: P.HAS_EXPRESSION, target: targetMsg });
    links.push({ source: srTop, predicate: P.HAS_TAG, target: tid });
  }

  // Batch — addLinks in chunks of 500
  const CHUNK = 500;
  for (let i = 0; i < links.length; i += CHUNK) {
    const r = await client.addLinks(uuid, links.slice(i, i + CHUNK));
    if (r.error) throw new Error(`addLinks failed: ${r.error}`);
  }

  return { channelId, messageIds, embeddingIds, srIds, topicIds, totalLinks: links.length };
}

// ----- Bench cases -----

type CaseRun = {
  label: string;
  sparql: ReturnType<typeof statsOf>;
  model: ReturnType<typeof statsOf>;
  sparqlErrors: number;
  modelErrors: number;
  ratio: number; // model.avg / sparql.avg
};

async function timeBoth(
  client: InstrumentedClient,
  uuid: string,
  label: string,
  runs: number,
  sparqlFn: () => Promise<any>,
  modelFn: () => Promise<any>,
): Promise<CaseRun> {
  // Warm-up
  await sparqlFn();
  await modelFn();

  const sLat: number[] = [];
  const mLat: number[] = [];
  let sErr = 0, mErr = 0;
  for (let i = 0; i < runs; i++) {
    const sStart = performance.now();
    const sRes = await sparqlFn();
    sLat.push(performance.now() - sStart);
    if (sRes?.error) sErr++;

    const mStart = performance.now();
    const mRes = await modelFn();
    mLat.push(performance.now() - mStart);
    if (mRes?.error) mErr++;
  }

  const s = statsOf(sLat);
  const m = statsOf(mLat);
  return {
    label,
    sparql: s,
    model: m,
    sparqlErrors: sErr,
    modelErrors: mErr,
    ratio: s.avg === 0 ? 0 : m.avg / s.avg,
  };
}

// ----- Scenario -----

export const s16SparqlVsModel: Scenario = {
  id: "s16",
  name: "SPARQL vs Ad4mModel",
  description:
    "Side-by-side benchmark of raw SPARQL vs Ad4mModel.findAll on identical Flux-shaped data. Drives the per-site convert-vs-keep decisions in flux/docs/sparql-to-ad4m-model-migration.md.",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    await client.generateAgent("wind-tunnel-s16");

    const RUNS = Number(process.env.S16_RUNS ?? "10");
    const tierResults: Record<string, {
      seedDurationMs: number;
      linkCount: number;
      cases: CaseRun[];
      includeWorks: boolean;
    }> = {};

    // SPARQL availability probe — if it's not on this branch, bail
    // gracefully so the scenario doesn't pollute results.
    {
      const probePerspective = await client.createPerspective("s16-probe");
      if (probePerspective.error) {
        return {
          scenario: "s16-sparql-vs-model",
          branch,
          startTime,
          endTime: Date.now(),
          durationMs: Date.now() - startTime,
          metrics: { error: probePerspective.error },
          samples,
          summary: `S16 FAILED: ${probePerspective.error}`,
        };
      }
      const probeUuid = probePerspective.data?.uuid || probePerspective.data?.id;
      const probe = await client.querySparql(probeUuid, "SELECT ?s WHERE { ?s ?p ?o } LIMIT 1");
      if (probe.error) {
        return {
          scenario: "s16-sparql-vs-model",
          branch,
          startTime,
          endTime: Date.now(),
          durationMs: Date.now() - startTime,
          metrics: { error: "SPARQL not available on this branch", branch },
          samples,
          summary: `S16 SKIPPED: SPARQL not available on ${branch}`,
        };
      }
    }

    for (const tier of TIERS) {
      console.log(`[s16] Tier ${tier.name}: ${tier.items} items + ${tier.topics} topics`);

      const persp = await client.createPerspective(`s16-${tier.name}`);
      if (persp.error) {
        console.log(`[s16] perspective.create failed for ${tier.name}: ${persp.error}`);
        continue;
      }
      const uuid = persp.data?.uuid || persp.data?.id;

      // Register subject classes
      const sdnaErrs: string[] = [];
      for (const [name, shacl] of [
        ["Message", SHACL_MESSAGE],
        ["Embedding", SHACL_EMBEDDING],
        ["Topic", SHACL_TOPIC],
        ["SemanticRelationship", SHACL_SR],
      ] as const) {
        const r = await client.addSdna(uuid, name, shacl);
        if (r.error) sdnaErrs.push(`${name}: ${r.error}`);
      }
      if (sdnaErrs.length) {
        console.log(`[s16] addSdna errors in tier ${tier.name}: ${sdnaErrs.join("; ")}`);
      }

      // Seed
      const seedStart = performance.now();
      let graph: Seeded;
      try {
        graph = await seedGraph(client, uuid, tier);
      } catch (err: any) {
        console.log(`[s16] seed failed for ${tier.name}: ${err.message}`);
        continue;
      }
      const seedDuration = performance.now() - seedStart;
      console.log(`[s16]   seeded ${graph.totalLinks} links in ${(seedDuration / 1000).toFixed(1)}s`);
      samples.push({ name: `seed_${tier.name}`, durationMs: seedDuration, timestamp: Date.now() });

      const sampleItem = graph.messageIds[Math.floor(graph.messageIds.length / 2)];

      const cases: CaseRun[] = [];

      // ----- Case 1: SR by expression (1 row, LIMIT 1) -----
      // Mirrors flux's SemanticRelationship.itemEmbedding(itemId) — the
      // raw SPARQL form joins SR → Embedding inline; the Ad4mModel form
      // is findAll({ where: { expression }, limit: 1 }).
      cases.push(await timeBoth(client, uuid, "sr_by_expression_limit1", RUNS,
        () => client.querySparql(uuid, `
          SELECT ?embedding WHERE {
            ?sr <${P.ENTRY_TYPE}> <${T.SemanticRelationship}> .
            ?sr <${P.HAS_EXPRESSION}> <${sampleItem}> .
            ?sr <${P.HAS_TAG}> ?embeddingId .
            ?embeddingId <${P.ENTRY_TYPE}> <${T.Embedding}> .
            ?embeddingId <${P.EMBEDDING}> ?embedding .
          } LIMIT 1
        `),
        () => client.modelQuery(uuid, "SemanticRelationship", JSON.stringify({
          where: { expression: sampleItem },
          limit: 1,
        })),
      ));

      // ----- Case 2: SR with include (does HasOne actually save a hop?) -----
      cases.push(await timeBoth(client, uuid, "sr_by_expression_with_include", RUNS,
        () => client.querySparql(uuid, `
          SELECT ?embedding WHERE {
            ?sr <${P.ENTRY_TYPE}> <${T.SemanticRelationship}> .
            ?sr <${P.HAS_EXPRESSION}> <${sampleItem}> .
            ?sr <${P.HAS_TAG}> ?embeddingId .
            ?embeddingId <${P.ENTRY_TYPE}> <${T.Embedding}> .
            ?embeddingId <${P.EMBEDDING}> ?embedding .
          } LIMIT 1
        `),
        () => client.modelQuery(uuid, "SemanticRelationship", JSON.stringify({
          where: { expression: sampleItem },
          include: { embeddingTag: true },
          limit: 1,
        })),
      ));

      // ----- Case 3: All SRs (no where, no limit) -----
      cases.push(await timeBoth(client, uuid, "sr_all", RUNS,
        () => client.querySparql(uuid, `
          SELECT ?sr ?expression ?tag WHERE {
            ?sr <${P.ENTRY_TYPE}> <${T.SemanticRelationship}> .
            ?sr <${P.HAS_EXPRESSION}> ?expression .
            ?sr <${P.HAS_TAG}> ?tag .
          }
        `),
        () => client.modelQuery(uuid, "SemanticRelationship", JSON.stringify({})),
      ));

      // ----- Case 4: All embeddings (large set, no joins) -----
      cases.push(await timeBoth(client, uuid, "embeddings_all", RUNS,
        () => client.querySparql(uuid, `
          SELECT ?e ?vec WHERE {
            ?e <${P.ENTRY_TYPE}> <${T.Embedding}> .
            ?e <${P.EMBEDDING}> ?vec .
          }
        `),
        () => client.modelQuery(uuid, "Embedding", JSON.stringify({})),
      ));

      // ----- Case 5: Topics list (small set) -----
      cases.push(await timeBoth(client, uuid, "topics_all", RUNS,
        () => client.querySparql(uuid, `
          SELECT ?t ?label WHERE {
            ?t <${P.ENTRY_TYPE}> <${T.Topic}> .
            ?t <${P.TOPIC}> ?label .
          }
        `),
        () => client.modelQuery(uuid, "Topic", JSON.stringify({})),
      ));

      // ----- Detect whether include actually fired -----
      // If avg of case 2 is within 5% of case 1, include is a no-op.
      const c1 = cases[0].model.avg;
      const c2 = cases[1].model.avg;
      const includeWorks = c1 > 0 && Math.abs(c2 - c1) / c1 > 0.05;

      tierResults[tier.name] = {
        seedDurationMs: Math.round(seedDuration),
        linkCount: graph.totalLinks,
        cases,
        includeWorks,
      };

      for (const c of cases) {
        samples.push({ name: `${tier.name}_${c.label}_sparql`, durationMs: c.sparql.avg, timestamp: Date.now() });
        samples.push({ name: `${tier.name}_${c.label}_model`, durationMs: c.model.avg, timestamp: Date.now() });
      }

      // Print a quick comparison row per tier
      console.log(`[s16] Tier ${tier.name} results:`);
      console.log(`[s16]   ${"case".padEnd(36)} ${"sparql avg".padStart(12)} ${"model avg".padStart(12)} ${"ratio".padStart(8)}`);
      for (const c of cases) {
        console.log(`[s16]   ${c.label.padEnd(36)} ${c.sparql.avg.toFixed(2).padStart(10)}ms ${c.model.avg.toFixed(2).padStart(10)}ms ${c.ratio.toFixed(2).padStart(7)}x`);
      }
      console.log(`[s16]   include actually fires: ${includeWorks}`);
    }

    const endTime = Date.now();

    // Build summary
    const summaryParts: string[] = [];
    for (const [tierName, td] of Object.entries(tierResults)) {
      const worst = td.cases.reduce((a, b) => (a.ratio > b.ratio ? a : b), td.cases[0]);
      summaryParts.push(`${tierName}: ${td.linkCount} links, worst=${worst.label}@${worst.ratio.toFixed(1)}x, include=${td.includeWorks ? "yes" : "no"}`);
    }

    return {
      scenario: "s16-sparql-vs-model",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics: { runsPerCase: RUNS, tiers: tierResults },
      samples,
      summary: summaryParts.join(". ") || "no tiers completed",
    };
  },
};

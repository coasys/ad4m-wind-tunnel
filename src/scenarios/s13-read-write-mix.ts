/**
 * S13: Read/Write Mix
 * Concurrent readers and writers on same perspective.
 * - 1 perspective, seeded with 10K links
 * - Configurations: (1w,5r), (5w,5r), (5w,25r)
 * - Writers: add links at 5/s each
 * - Readers: query all links every 200ms
 * - Duration: 30s per configuration
 * - Metrics: read latency under write load, write latency under read load, consistency checks
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { InstrumentedClient } from "../client.js";
import { sleep } from "../executor.js";

const SEED_LINKS = 10_000;
const SEED_BATCH_SIZE = 500;
const CONFIGURATIONS: { writers: number; readers: number }[] = [
  { writers: 1, readers: 5 },
  { writers: 5, readers: 5 },
  { writers: 5, readers: 25 },
];
const DURATION_SEC = 30;
const WRITE_RATE_PER_SEC = 5; // per writer
const READ_INTERVAL_MS = 200; // per reader

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

interface ConfigResult {
  config: string;
  writers: number;
  readers: number;
  durationMs: number;
  writeMetrics: {
    totalWrites: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    errors: number;
    throughputPerSec: number;
  };
  readMetrics: {
    totalReads: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    errors: number;
    throughputPerSec: number;
    avgResultCount: number;
  };
  consistency: {
    finalLinkCount: number;
    expectedMinLinks: number;
    linksVisible: boolean;
  };
}

export const s13ReadWriteMix: Scenario = {
  id: "s13",
  name: "Read/Write Mix",
  description: "Concurrent readers and writers on same perspective, measure latency and consistency",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Setup
    await client.generateAgent("wind-tunnel-read-write-mix");
    const perspective = await client.createPerspective("read-write-mix");
    if (perspective.error) {
      return {
        scenario: "s13-read-write-mix",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        metrics: { error: perspective.error },
        samples,
        summary: `S13 FAILED: ${perspective.error}`,
      };
    }

    const uuid = perspective.data?.uuid || perspective.data?.id;
    const adminToken = client.config.adminToken;

    // Seed links
    console.log(`[s13] Seeding ${SEED_LINKS} links...`);
    const seedStart = performance.now();
    for (let i = 0; i < SEED_LINKS; i++) {
      await client.addLink(uuid, `ad4m://seed-${i % 100}`, "ad4m://has", `literal://seed-${i}`);
      if ((i + 1) % 2000 === 0) {
        console.log(`[s13]   Seeded ${i + 1}/${SEED_LINKS}...`);
      }
    }
    const seedDuration = performance.now() - seedStart;
    console.log(`[s13] Seeding complete in ${(seedDuration / 1000).toFixed(1)}s`);
    samples.push({ name: "seed_links", durationMs: seedDuration, timestamp: Date.now() });

    const configResults: ConfigResult[] = [];

    for (const config of CONFIGURATIONS) {
      const { writers, readers } = config;
      const configLabel = `${writers}w_${readers}r`;
      console.log(`[s13] Configuration: ${writers} writers, ${readers} readers for ${DURATION_SEC}s...`);
      const configStart = performance.now();

      // Tracking arrays
      const writeLatencies: number[] = [];
      const readLatencies: number[] = [];
      const readResultCounts: number[] = [];
      let writeErrors = 0;
      let readErrors = 0;
      let totalWritten = 0;

      // Signal to stop
      let running = true;

      // Create separate clients for writers and readers
      const writerClients: InstrumentedClient[] = [];
      const readerClients: InstrumentedClient[] = [];

      for (let i = 0; i < writers; i++) {
        const c = new InstrumentedClient({ port, adminToken });
        await c.connect();
        writerClients.push(c);
      }
      for (let i = 0; i < readers; i++) {
        const c = new InstrumentedClient({ port, adminToken });
        await c.connect();
        readerClients.push(c);
      }

      // Writer tasks: add links at WRITE_RATE_PER_SEC
      const writerTasks = writerClients.map(async (wc, wIdx) => {
        const writeIntervalMs = 1000 / WRITE_RATE_PER_SEC;
        let writeNum = 0;
        while (running) {
          const writeStart = performance.now();
          const result = await wc.addLink(
            uuid,
            `ad4m://writer-${wIdx}`,
            "ad4m://mixed",
            `literal://w${wIdx}-${writeNum++}`
          );
          writeLatencies.push(result.durationMs);
          if (result.error) writeErrors++;
          else totalWritten++;

          const elapsed = performance.now() - writeStart;
          const waitTime = writeIntervalMs - elapsed;
          if (waitTime > 0 && running) await sleep(waitTime);
        }
      });

      // Reader tasks: query every READ_INTERVAL_MS
      const readerTasks = readerClients.map(async (rc, rIdx) => {
        while (running) {
          const result = await rc.queryLinks(uuid, { predicate: "ad4m://has" });
          readLatencies.push(result.durationMs);
          if (result.error) {
            readErrors++;
          } else {
            const count = Array.isArray(result.data) ? result.data.length : 0;
            readResultCounts.push(count);
          }
          await sleep(READ_INTERVAL_MS);
        }
      });

      // Run for DURATION_SEC
      await sleep(DURATION_SEC * 1000);
      running = false;

      // Wait for all tasks to finish (with timeout)
      await Promise.race([
        Promise.all([...writerTasks, ...readerTasks]),
        sleep(5000), // 5s grace period
      ]);

      const configDuration = performance.now() - configStart;

      // Disconnect clients
      for (const c of writerClients) await c.disconnect();
      for (const c of readerClients) await c.disconnect();

      // Sort latencies
      const sortedWrite = [...writeLatencies].sort((a, b) => a - b);
      const sortedRead = [...readLatencies].sort((a, b) => a - b);

      // Final consistency check: query and see if all writes are visible
      const finalQuery = await client.queryLinks(uuid, { predicate: "ad4m://mixed" });
      const finalCount = Array.isArray(finalQuery.data) ? finalQuery.data.length : 0;

      const configResult: ConfigResult = {
        config: configLabel,
        writers,
        readers,
        durationMs: Math.round(configDuration),
        writeMetrics: {
          totalWrites: writeLatencies.length,
          avgMs: sortedWrite.length > 0 ? Math.round((sortedWrite.reduce((a, b) => a + b, 0) / sortedWrite.length) * 100) / 100 : 0,
          p50Ms: Math.round(percentile(sortedWrite, 0.5) * 100) / 100,
          p95Ms: Math.round(percentile(sortedWrite, 0.95) * 100) / 100,
          p99Ms: Math.round(percentile(sortedWrite, 0.99) * 100) / 100,
          errors: writeErrors,
          throughputPerSec: Math.round((writeLatencies.length / (configDuration / 1000)) * 10) / 10,
        },
        readMetrics: {
          totalReads: readLatencies.length,
          avgMs: sortedRead.length > 0 ? Math.round((sortedRead.reduce((a, b) => a + b, 0) / sortedRead.length) * 100) / 100 : 0,
          p50Ms: Math.round(percentile(sortedRead, 0.5) * 100) / 100,
          p95Ms: Math.round(percentile(sortedRead, 0.95) * 100) / 100,
          p99Ms: Math.round(percentile(sortedRead, 0.99) * 100) / 100,
          errors: readErrors,
          throughputPerSec: Math.round((readLatencies.length / (configDuration / 1000)) * 10) / 10,
          avgResultCount: readResultCounts.length > 0
            ? Math.round(readResultCounts.reduce((a, b) => a + b, 0) / readResultCounts.length)
            : 0,
        },
        consistency: {
          finalLinkCount: finalCount,
          expectedMinLinks: totalWritten,
          linksVisible: finalCount >= totalWritten,
        },
      };

      configResults.push(configResult);

      samples.push({
        name: `config_${configLabel}`,
        durationMs: configDuration,
        timestamp: Date.now(),
      });

      console.log(`[s13] ${configLabel}: writes=${configResult.writeMetrics.totalWrites} (avg=${configResult.writeMetrics.avgMs.toFixed(1)}ms), reads=${configResult.readMetrics.totalReads} (avg=${configResult.readMetrics.avgMs.toFixed(1)}ms), consistent=${configResult.consistency.linksVisible}`);

      // Small pause between configs
      await sleep(2000);
    }

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    const metrics = {
      seedLinks: SEED_LINKS,
      seedDurationMs: Math.round(seedDuration),
      configurations: configResults,
      durationPerConfigSec: DURATION_SEC,
    };

    const lastConfig = configResults[configResults.length - 1];
    const summary = [
      `Tested ${CONFIGURATIONS.map((c) => `${c.writers}w/${c.readers}r`).join(", ")}.`,
      lastConfig ? `At ${lastConfig.writers}w/${lastConfig.readers}r: write avg=${lastConfig.writeMetrics.avgMs.toFixed(1)}ms P95=${lastConfig.writeMetrics.p95Ms.toFixed(1)}ms, read avg=${lastConfig.readMetrics.avgMs.toFixed(1)}ms P95=${lastConfig.readMetrics.p95Ms.toFixed(1)}ms` : "",
      lastConfig ? `Consistency: ${lastConfig.consistency.linksVisible ? "OK" : "FAILED"}` : "",
    ].join(" ");

    return {
      scenario: "s13-read-write-mix",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      metrics,
      samples,
      summary,
    };
  },
};

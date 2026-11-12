/**
 * Reporters: Console and JSON
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { cpus, totalmem } from "os";
import { ScenarioResult } from "./scenario.js";

export function consoleReport(results: ScenarioResult[]): void {
  console.log("\n" + "=".repeat(80));
  console.log("  AD4M WIND TUNNEL — RESULTS");
  console.log("=".repeat(80));

  for (const r of results) {
    const verdict = r.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`\n┌─ ${r.scenario} [${r.branch}] ${verdict}`);
    console.log(`│  Duration: ${r.durationMs}ms`);
    console.log(`│  Summary: ${r.summary}`);

    if (r.metrics.error) {
      console.log(`│  ❌ ERROR: ${r.metrics.error}`);
    }

    // Print key metrics
    const skipKeys = ["error", "scalingResults", "batchLatenciesMs", "batchErrors"];
    for (const [key, value] of Object.entries(r.metrics)) {
      if (skipKeys.includes(key)) continue;
      if (typeof value === "number") {
        console.log(`│  ${key}: ${typeof value === "number" ? value.toFixed(2) : value}`);
      }
    }
    console.log(`└${"─".repeat(79)}`);
  }

  console.log("\n" + "=".repeat(80) + "\n");
}

export function jsonReport(results: ScenarioResult[], outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });

  for (const r of results) {
    const base = r.scenario.replace(/[^a-z0-9._-]/gi, "-");
    const filepath = join(outputDir, `${base}.json`);
    writeFileSync(filepath, JSON.stringify(r, null, 2));
    const mdPath = join(outputDir, `${base}.md`);
    writeFileSync(mdPath, markdownReport(r));
    console.log(`[reporter] Wrote ${filepath} (+ .md)`);
  }
}

/** The environment block every markdown report starts with. */
export function environmentMarkdown(r: ScenarioResult): string {
  const e = r.environment;
  if (!e) return "_No environment recorded._\n";
  const la = (v: [number, number, number] | null) => (v ? v.map((x) => x.toFixed(2)).join(" / ") : "?");
  return [
    "| Field | Value |",
    "| --- | --- |",
    `| ad4m commit | ${e.ad4mCommit ?? "unknown"} |`,
    `| Executor version | ${e.ad4mExecutorVersion ?? e.executorVersionString ?? "unknown"} |`,
    `| Holochain (--run-holochain) | ${e.runHolochain === null ? "default" : e.runHolochain ? "on" : "off"} |`,
    `| Machine | ${e.machine.cpuCount} CPUs (${e.machine.cpuModel ?? "?"}), ${e.machine.totalRamGb} GB RAM, ${e.machine.os}, kernel ${e.machine.kernel} |`,
    `| Load average start (1/5/15 min) | ${la(e.loadAvgStart)} |`,
    `| Load average end (1/5/15 min) | ${la(e.loadAvgEnd)} |`,
    `| Host swap used start / end | ${e.hostSwapUsedKbStart ?? "?"} kB / ${e.hostSwapUsedKbEnd ?? "?"} kB |`,
    `| Run | ${e.runIndex} |`,
    `| Started | ${e.startedAt} |`,
    "",
  ].join("\n");
}

/** Scenario-supplied markdown, or a flat dump of the scalar metrics. */
export function markdownReport(r: ScenarioResult): string {
  const verdict = r.skipped ? "SKIPPED" : r.passed ? "PASS" : "FAIL";
  const lines = [
    `# ${r.scenario} — ${verdict}`,
    "",
    `Branch label: \`${r.branch}\` · duration ${(r.durationMs / 1000).toFixed(1)} s`,
    "",
    `**Summary:** ${r.summary}`,
    "",
    "## Environment",
    "",
    environmentMarkdown(r),
  ];
  if (r.markdown) {
    lines.push(r.markdown);
  } else {
    lines.push("## Metrics", "", "| Metric | Value |", "| --- | --- |");
    for (const [k, v] of Object.entries(r.metrics)) {
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
        lines.push(`| ${k} | ${typeof v === "number" ? +v.toFixed(3) : v} |`);
      }
    }
    lines.push("", "Raw samples and nested metrics: see the JSON file.");
  }
  return lines.join("\n") + "\n";
}

export function comparisonReport(
  allResults: Map<string, ScenarioResult[]>,
  outputPath: string
): void {
  const lines: string[] = [];
  lines.push("# AD4M Wind Tunnel — Comparison Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Machine: ${cpus().length} CPUs (${cpus()[0]?.model ?? "?"}), ${(totalmem() / 1024 ** 3).toFixed(0)} GB RAM`);
  lines.push("");

  // Get scenario IDs from first branch results
  const branches = [...allResults.keys()];
  const firstResults = allResults.get(branches[0]) || [];
  const scenarioIds = firstResults.map((r) => r.scenario);

  for (const scenarioId of scenarioIds) {
    lines.push(`## ${scenarioId}`);
    lines.push("");

    // Table header
    lines.push("| Metric | " + branches.join(" | ") + " |");
    lines.push("| --- | " + branches.map(() => "---").join(" | ") + " |");

    // Collect metrics across branches for this scenario
    const metricsMap = new Map<string, Map<string, string>>();

    for (const branch of branches) {
      const branchResults = allResults.get(branch) || [];
      const result = branchResults.find((r) => r.scenario === scenarioId);
      if (!result) continue;

      for (const [key, value] of Object.entries(result.metrics)) {
        if (typeof value === "object" && !Array.isArray(value)) continue;
        if (Array.isArray(value)) continue;

        if (!metricsMap.has(key)) {
          metricsMap.set(key, new Map());
        }
        metricsMap.get(key)!.set(
          branch,
          typeof value === "number" ? value.toFixed(2) : String(value)
        );
      }
    }

    for (const [metric, values] of metricsMap) {
      const row = branches.map((b) => values.get(b) || "—");
      lines.push(`| ${metric} | ${row.join(" | ")} |`);
    }

    lines.push("");

    // Summary row
    lines.push("**Summaries:**");
    for (const branch of branches) {
      const branchResults = allResults.get(branch) || [];
      const result = branchResults.find((r) => r.scenario === scenarioId);
      if (result) {
        lines.push(`- **${branch}:** ${result.summary}`);
      }
    }
    lines.push("");
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, lines.join("\n"));
  console.log(`[reporter] Wrote comparison report: ${outputPath}`);
}

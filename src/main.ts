/**
 * AD4M Wind Tunnel — Main Runner
 */

import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { InstrumentedClient } from "./client.js";
import { buildExecutor, startExecutor, waitForHealth, stopExecutor, sleep, initExecutor, ExecutorConfig } from "./executor.js";
import { Scenario, ScenarioContext, ScenarioResult } from "./scenario.js";
import {
  s1ColdStart, s2LinkThroughput, s2bMillionLinks, s3PerspectiveScaling, s4LanguageInstallStorm,
  s5QueryScaling, s6ApiConcurrency, s7MemoryStability, s8SubjectClassQueries,
  m1NeighbourhoodSync, m2MultiExecutorScale, m3LinkLanguageComparison,
  m4WriteLoadUnderSync, m5ConcurrentNeighbourhoods,
  a1McpThroughput,
  s9NeighbourhoodMemoryLeak,
  s10SubscriptionFanout, s12PersistenceColdQuery, s13ReadWriteMix, s14MultiPerspectiveLoad,
  s15LeakAttribution, s16SparqlVsModel,
} from "./scenarios/index.js";
import { consoleReport, jsonReport, comparisonReport } from "./reporters.js";
import { config, validateAdamRepo } from "./config.js";

const RESULTS_DIR = config.resultsDir;

const ALL_SCENARIOS: Scenario[] = [
  s1ColdStart, s2LinkThroughput, s2bMillionLinks, s3PerspectiveScaling, s4LanguageInstallStorm,
  s5QueryScaling, s6ApiConcurrency, s7MemoryStability, s8SubjectClassQueries,
  m1NeighbourhoodSync, m2MultiExecutorScale, m3LinkLanguageComparison,
  m4WriteLoadUnderSync, m5ConcurrentNeighbourhoods,
  a1McpThroughput,
  s9NeighbourhoodMemoryLeak,
  s10SubscriptionFanout, s12PersistenceColdQuery, s13ReadWriteMix, s14MultiPerspectiveLoad,
  s15LeakAttribution, s16SparqlVsModel,
];

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    scenarios: [] as string[],
    branches: [] as string[],
    skipBuild: false,
    executorPath: undefined as string | undefined,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--scenario": result.scenarios.push(args[++i]); break;
      case "--branch": result.branches.push(args[++i]); break;
      case "--skip-build": result.skipBuild = true; break;
      case "--executor-path": result.executorPath = args[++i]; break;
    }
  }
  return result;
}

/** Derive a filesystem-safe directory name from a branch name */
function branchToDirName(branch: string): string {
  return branch.replace(/\//g, "-");
}

async function runScenariosForBranch(
  branch: string,
  scenarios: Scenario[],
  binaryPath: string,
  port: number
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const dirName = branchToDirName(branch);

  for (const scenario of scenarios) {
    console.log(`\n[runner] Running ${scenario.id}: ${scenario.name} on ${branch}...`);

    // Fresh executor for each scenario
    const dataPath = join(config.tmpDirBase, `ad4m-wt-data-${dirName}-${scenario.id}`);
    // S9 in `no-languages` mode boots the executor with --language-language-only
    // so only the language-language Deno runtime loads. This is set here
    // because executor flags must be picked at spawn time, not from the scenario.
    const extraArgs: string[] = [];
    if (scenario.id === "s9" && (process.env.S9_MODE || "").toLowerCase() === "no-languages") {
      extraArgs.push("--language-language-only", "true");
    }
    const config_: ExecutorConfig = {
      branch,
      port,
      dataPath,
      adminToken: config.adminToken,
      adamRepoPath: config.adamRepoPath,
      buildDir: join(config.tmpDirBase, `ad4m-build-${dirName}`),
      extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
    };

    let proc: any = null;
    let proc2: any = null;

    try {
      proc = await startExecutor(binaryPath, config_);

      // Wait for health
      const healthWaitMs = await waitForHealth(port, 120000, config.adminToken);
      console.log(`[runner] Executor healthy after ${healthWaitMs.toFixed(0)}ms`);

      // For M1, start a second executor
      if (scenario.id === "m1") {
        const dataPath2 = join(config.tmpDirBase, `ad4m-wt-data-${dirName}-m1-2`);
        const config2 = { ...config_, port: port + 1, dataPath: dataPath2 };
        try {
          proc2 = await startExecutor(binaryPath, config2);
          await waitForHealth(port + 1, 120000, config.adminToken);
          console.log(`[runner] Second executor healthy on port ${port + 1}`);
        } catch (err: any) {
          console.log(`[runner] Second executor failed: ${err.message}`);
          if (proc2) stopExecutor(proc2);
          proc2 = null;
        }
      }

      // Create client
      const client = new InstrumentedClient({
        port,
        adminToken: config.adminToken,
      });

      await client.connect();

      const ctx: ScenarioContext = {
        client,
        branch,
        port,
        adminToken: config.adminToken,
        adamRepoPath: config.adamRepoPath,
        tmpDirBase: config.tmpDirBase,
      };

      try {
        const result = await scenario.run(ctx);
        results.push(result);
        console.log(`[runner] ${scenario.id} complete: ${result.summary}`);
      } catch (err: any) {
        console.error(`[runner] ${scenario.id} CRASHED: ${err.message}`);
        results.push({
          scenario: `${scenario.id}-${scenario.name.toLowerCase().replace(/\s+/g, "-")}`,
          branch,
          startTime: Date.now(),
          endTime: Date.now(),
          durationMs: 0,
          metrics: { error: err.message },
          samples: [],
          summary: `CRASHED: ${err.message}`,
        });
      } finally {
        await client.disconnect();
      }
    } catch (err: any) {
      console.error(`[runner] Failed to start executor for ${scenario.id}: ${err.message}`);
      results.push({
        scenario: `${scenario.id}-${scenario.name.toLowerCase().replace(/\s+/g, "-")}`,
        branch,
        startTime: Date.now(),
        endTime: Date.now(),
        durationMs: 0,
        metrics: { error: `Executor start failed: ${err.message}` },
        samples: [],
        summary: `EXECUTOR FAILED: ${err.message}`,
      });
    } finally {
      if (proc2) stopExecutor(proc2);
      if (proc) stopExecutor(proc);
      await sleep(2000);
      // Cleanup data
      if (existsSync(join(config.tmpDirBase, `ad4m-wt-data-${dirName}-${scenario.id}`))) {
        rmSync(join(config.tmpDirBase, `ad4m-wt-data-${dirName}-${scenario.id}`), { recursive: true, force: true });
      }
    }
  }

  return results;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║            AD4M WIND TUNNEL — Performance Testing           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`\nConfig: ${JSON.stringify(args, null, 2)}\n`);

  const scenarios = args.scenarios.length > 0
    ? ALL_SCENARIOS.filter((s) => args.scenarios.includes(s.id))
    : ALL_SCENARIOS;

  // Branches come from CLI args; default to "default" label if none specified
  const branches = args.branches.length > 0
    ? args.branches
    : ["default"];

  console.log(`Scenarios: ${scenarios.map((s) => s.id).join(", ")}`);
  console.log(`Branches: ${branches.join(", ")}`);

  // Locate binaries
  const binaryPaths = new Map<string, string>();
  if (args.executorPath) {
    for (const b of branches) binaryPaths.set(b, args.executorPath);
  } else if (args.skipBuild) {
    for (const b of branches) {
      const dirName = branchToDirName(b);
      const path = join(config.tmpDirBase, `ad4m-build-${dirName}`, "target", "release", "ad4m-executor");
      if (existsSync(path)) {
        binaryPaths.set(b, path);
      } else {
        console.error(`[runner] No binary for ${b} at ${path}`);
        process.exit(1);
      }
    }
  } else {
    validateAdamRepo();
    for (const b of branches) {
      const dirName = branchToDirName(b);
      const buildDir = join(config.tmpDirBase, `ad4m-build-${dirName}`);
      console.log(`\n[build] Building ${b}...`);
      const start = performance.now();
      try {
        const path = await buildExecutor({
          branch: b, port: config.basePort, dataPath: "",
          adminToken: config.adminToken, adamRepoPath: config.adamRepoPath, buildDir,
        });
        console.log(`[build] ${b} built in ${((performance.now() - start) / 1000).toFixed(0)}s`);
        binaryPaths.set(b, path);
      } catch (err: any) {
        console.error(`[build] FAILED ${b}: ${err.message}`);
      }
    }
  }

  if (binaryPaths.size === 0) {
    console.error("[runner] No executors available. Exiting.");
    process.exit(1);
  }

  // Run scenarios
  const allResults = new Map<string, ScenarioResult[]>();
  let portOffset = 0;

  for (const branch of branches) {
    const binaryPath = binaryPaths.get(branch);
    if (!binaryPath) { console.log(`[runner] Skipping ${branch}`); continue; }

    const port = config.basePort + portOffset * 10;
    portOffset++;

    const dirName = branchToDirName(branch);

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  Branch: ${branch} | Binary: ${binaryPath}`);
    console.log(`  Port: ${port}`);
    console.log(`${"═".repeat(60)}\n`);

    const results = await runScenariosForBranch(branch, scenarios, binaryPath, port);
    allResults.set(dirName, results);

    // Save results
    jsonReport(results, join(RESULTS_DIR, dirName));
    consoleReport(results);
  }

  // Generate comparison report
  if (allResults.size > 1) {
    comparisonReport(allResults, join(RESULTS_DIR, "comparison.md"));
  }

  console.log("\n[runner] All done! Results in ./results/");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

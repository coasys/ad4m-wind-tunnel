/**
 * AD4M Wind Tunnel — Main Runner
 */

import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { InstrumentedClient, Transport } from "./client.js";
import { buildExecutor, startExecutor, waitForHealth, stopExecutor, sleep, initExecutor, ExecutorConfig } from "./executor.js";
import { Scenario, ScenarioContext, ScenarioResult } from "./scenario.js";
import { s1ColdStart, s2LinkThroughput, s5QueryScaling, m1NeighbourhoodSync } from "./scenarios/index.js";
import { consoleReport, jsonReport, comparisonReport } from "./reporters.js";

const AD4M_REPO = "/Users/josh/workspaces/coasys/ad4m";
const RESULTS_DIR = join(process.cwd(), "results");
const BASE_PORT = 12100;

interface BranchConfig {
  name: string;
  transport: Transport;
  dirName: string;
}

const BRANCHES: BranchConfig[] = [
  { name: "dev", transport: "graphql", dirName: "dev" },
  { name: "feat/sse-to-websocket", transport: "rest", dirName: "feat-sse-to-websocket" },
  { name: "feat/sparql-1.2-cleanup", transport: "graphql", dirName: "feat-sparql-1.2-cleanup" },
];

const ALL_SCENARIOS: Scenario[] = [s1ColdStart, s2LinkThroughput, s5QueryScaling, m1NeighbourhoodSync];

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

async function runScenariosForBranch(
  branchConfig: BranchConfig,
  scenarios: Scenario[],
  binaryPath: string,
  port: number
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    console.log(`\n[runner] Running ${scenario.id}: ${scenario.name} on ${branchConfig.name}...`);

    // Fresh executor for each scenario
    const dataPath = `/tmp/ad4m-wt-data-${branchConfig.dirName}-${scenario.id}`;
    const config: ExecutorConfig = {
      branch: branchConfig.name,
      port,
      dataPath,
      adminToken: "test123",
      adamRepoPath: AD4M_REPO,
      buildDir: `/tmp/ad4m-build-${branchConfig.dirName}`,
      transport: branchConfig.transport,
    };

    let proc: any = null;
    let proc2: any = null;

    try {
      proc = await startExecutor(binaryPath, config);

      // Wait for health
      const healthWaitMs = await waitForHealth(port, branchConfig.transport, 120000);
      console.log(`[runner] Executor healthy after ${healthWaitMs.toFixed(0)}ms`);

      // For M1, start a second executor
      if (scenario.id === "m1") {
        const dataPath2 = `/tmp/ad4m-wt-data-${branchConfig.dirName}-m1-2`;
        const config2 = { ...config, port: port + 1, dataPath: dataPath2 };
        try {
          proc2 = await startExecutor(binaryPath, config2);
          await waitForHealth(port + 1, branchConfig.transport, 120000);
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
        adminToken: "test123",
        transport: branchConfig.transport,
      });

      if (branchConfig.transport === "ws") {
        await client.connect();
      }

      const ctx: ScenarioContext = { client, branch: branchConfig.name, port };

      try {
        const result = await scenario.run(ctx);
        results.push(result);
        console.log(`[runner] ${scenario.id} complete: ${result.summary}`);
      } catch (err: any) {
        console.error(`[runner] ${scenario.id} CRASHED: ${err.message}`);
        results.push({
          scenario: `${scenario.id}-${scenario.name.toLowerCase().replace(/\s+/g, "-")}`,
          branch: branchConfig.name,
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
        branch: branchConfig.name,
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
      if (existsSync(`/tmp/ad4m-wt-data-${branchConfig.dirName}-${scenario.id}`)) {
        rmSync(`/tmp/ad4m-wt-data-${branchConfig.dirName}-${scenario.id}`, { recursive: true, force: true });
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

  const branches = args.branches.length > 0
    ? BRANCHES.filter((b) => args.branches.includes(b.name) || args.branches.includes(b.dirName))
    : BRANCHES;

  console.log(`Scenarios: ${scenarios.map((s) => s.id).join(", ")}`);
  console.log(`Branches: ${branches.map((b) => b.name).join(", ")}`);

  // Locate binaries
  const binaryPaths = new Map<string, string>();
  if (args.executorPath) {
    for (const b of branches) binaryPaths.set(b.name, args.executorPath);
  } else if (args.skipBuild) {
    for (const b of branches) {
      const path = join(`/tmp/ad4m-build-${b.dirName}`, "target", "release", "ad4m-executor");
      if (existsSync(path)) {
        binaryPaths.set(b.name, path);
      } else {
        console.error(`[runner] No binary for ${b.name} at ${path}`);
        process.exit(1);
      }
    }
  } else {
    for (const b of branches) {
      const buildDir = `/tmp/ad4m-build-${b.dirName}`;
      console.log(`\n[build] Building ${b.name}...`);
      const start = performance.now();
      try {
        const path = await buildExecutor({
          branch: b.name, port: BASE_PORT, dataPath: "",
          adminToken: "test123", adamRepoPath: AD4M_REPO, buildDir, transport: b.transport,
        });
        console.log(`[build] ${b.name} built in ${((performance.now() - start) / 1000).toFixed(0)}s`);
        binaryPaths.set(b.name, path);
      } catch (err: any) {
        console.error(`[build] FAILED ${b.name}: ${err.message}`);
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

  for (const branchConfig of branches) {
    const binaryPath = binaryPaths.get(branchConfig.name);
    if (!binaryPath) { console.log(`[runner] Skipping ${branchConfig.name}`); continue; }

    const port = BASE_PORT + portOffset * 10;
    portOffset++;

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  Branch: ${branchConfig.name} | Binary: ${binaryPath}`);
    console.log(`  Port: ${port} | Transport: ${branchConfig.transport}`);
    console.log(`${"═".repeat(60)}\n`);

    const results = await runScenariosForBranch(branchConfig, scenarios, binaryPath, port);
    allResults.set(branchConfig.dirName, results);

    // Save results
    jsonReport(results, join(RESULTS_DIR, branchConfig.dirName));
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

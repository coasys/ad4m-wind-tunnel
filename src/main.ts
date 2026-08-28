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
  c1Convergence,
  a3McpThroughput,
  a2ProvisionConnect,
  a4Waker,
  a5AvLoop,
  s9NeighbourhoodMemoryLeak,
  s10SubscriptionFanout, s12PersistenceColdQuery, s13ReadWriteMix, s14MultiPerspectiveLoad,
  s15LeakAttribution,
  // WebRTC mesh baselines
  w1Mesh2Peer, w1mMeshMultiMachine, w2Mesh4Peer, w3MeshRtt, w4MeshBandwidthScaling,
  w5TurnFallback,
  // SFU topology
  t1Sfu5Peer, t2Sfu10Peer, t3SfuCascade2Node, t4SfuCascade3Node,
  t5TopologyTable, t6PipeHandshake,
  t7SfuCascadeMedia, t8ConcurrentJoinRace, t9TrackDidAttribution, t10SimulcastLayerSelection,
  // Mid-call topology transitions
  m1MeshToSfu, m2SfuToMesh, m3CascadeFailover, m4SfuOfflineFallback,
  // Faults
  f1MeshPacketLoss, f2SfuPacketLoss, f3OneWayNat, f4NetworkPartition,
  f5RenegotiationFlood, f6NonMemberJoin, f7BadCapability,
  f8StuckRenegotiationRecovery, f9CascadeNodeCrashCleanup,
  // SFU scale
  s1Sfu20Peer, s2SfuCascade4Node, s3MaxParticipantsEnforced,
  s4SfuMemoryChurn,
  // SFU rebalancing
  t11CascadeRebalance,
  // Session surface
  t16SessionLifecycle, t17SessionDataChannel,
  t18MeshSessionLifecycle, t19MeshDataChannel,
} from "./scenarios/index.js";
import { consoleReport, jsonReport, comparisonReport } from "./reporters.js";
import { config, validateAdamRepo } from "./config.js";

const RESULTS_DIR = config.resultsDir;

const ALL_SCENARIOS: Scenario[] = [
  // Core executor scenarios
  s1ColdStart, s2LinkThroughput, s2bMillionLinks, s3PerspectiveScaling, s4LanguageInstallStorm,
  s5QueryScaling, s6ApiConcurrency, s7MemoryStability, s8SubjectClassQueries,
  m1NeighbourhoodSync, m2MultiExecutorScale, m3LinkLanguageComparison,
  m4WriteLoadUnderSync, m5ConcurrentNeighbourhoods,
  c1Convergence,
  a3McpThroughput,
  a2ProvisionConnect,
  a4Waker,
  a5AvLoop,
  s9NeighbourhoodMemoryLeak,
  s10SubscriptionFanout, s12PersistenceColdQuery, s13ReadWriteMix, s14MultiPerspectiveLoad,
  s15LeakAttribution,
  // WebRTC mesh baselines
  w1Mesh2Peer, w1mMeshMultiMachine, w2Mesh4Peer, w3MeshRtt, w4MeshBandwidthScaling,
  w5TurnFallback,
  // SFU topology
  t1Sfu5Peer, t2Sfu10Peer, t3SfuCascade2Node, t4SfuCascade3Node,
  t5TopologyTable, t6PipeHandshake,
  t7SfuCascadeMedia, t8ConcurrentJoinRace, t9TrackDidAttribution, t10SimulcastLayerSelection,
  // Mid-call topology transitions
  m1MeshToSfu, m2SfuToMesh, m3CascadeFailover, m4SfuOfflineFallback,
  // Faults
  f1MeshPacketLoss, f2SfuPacketLoss, f3OneWayNat, f4NetworkPartition,
  f5RenegotiationFlood, f6NonMemberJoin, f7BadCapability,
  f8StuckRenegotiationRecovery, f9CascadeNodeCrashCleanup,
  // SFU scale
  s1Sfu20Peer, s2SfuCascade4Node, s3MaxParticipantsEnforced,
  s4SfuMemoryChurn,
  // SFU rebalancing
  t11CascadeRebalance,
  // Session surface
  t16SessionLifecycle, t17SessionDataChannel,
  t18MeshSessionLifecycle, t19MeshDataChannel,
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

    // Pod-managed scenarios (agent-harness A-series) stand up and tear down
    // their own Docker environment; the runner does not boot a native executor
    // or a client for them.
    if (scenario.managesOwnEnvironment) {
      console.log(`[runner] ${scenario.id} manages its own environment — skipping native executor`);
      const ctx: ScenarioContext = {
        client: undefined as any,
        branch,
        port,
        adminToken: config.adminToken,
        adamRepoPath: config.adamRepoPath,
        tmpDirBase: config.tmpDirBase,
        executorPath: binaryPath || undefined,
      };
      try {
        const result = await scenario.run(ctx);
        results.push(result);
        console.log(`[runner] ${scenario.id} ${result.passed ? "PASS" : "FAIL"}: ${result.summary}`);
      } catch (err: any) {
        console.error(`[runner] ${scenario.id} CRASHED: ${err.message}`);
        results.push({
          scenario: `${scenario.id}-provision-connect`,
          branch,
          passed: false,
          startTime: Date.now(),
          endTime: Date.now(),
          durationMs: 0,
          metrics: { error: err.message },
          samples: [],
          summary: `CRASHED: ${err.message}`,
        });
      }
      continue;
    }

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

      // Generate agent identity (creates the main key needed for JWT minting)
      try {
        await client.call("agent.generate", { passphrase: "wind-tunnel-test" });
        console.log(`[runner] Agent identity generated`);
      } catch (err: any) {
        if (!err.message?.includes("already")) {
          console.log(`[runner] agent.generate: ${err.message}`);
        }
      }

      const ctx: ScenarioContext = {
        client,
        branch,
        port,
        adminToken: config.adminToken,
        adamRepoPath: config.adamRepoPath,
        tmpDirBase: config.tmpDirBase,
        executorPath: binaryPath,
      };

      try {
        const result = await scenario.run(ctx);
        results.push(result);
        const verdict = result.passed ? "PASS" : "FAIL";
        console.log(`[runner] ${scenario.id} ${verdict}: ${result.summary}`);
      } catch (err: any) {
        console.error(`[runner] ${scenario.id} CRASHED: ${err.message}`);
        results.push({
          scenario: `${scenario.id}-${scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}`,
          branch,
          passed: false,
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
        scenario: `${scenario.id}-${scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}`,
        branch,
        passed: false,
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

  // Locate binaries. Pod-managed scenarios (agent-harness A-series) run their
  // own containerised node, so a native executor binary is only required when a
  // non-pod scenario is selected.
  const binaryPaths = new Map<string, string>();
  const needsBinary = scenarios.some((s) => !s.managesOwnEnvironment);
  if (!needsBinary) {
    // Non-empty placeholder: pod-managed scenarios ignore it, but the run loop
    // treats an empty string as "no binary" and would skip the branch.
    for (const b of branches) binaryPaths.set(b, "pod-managed");
  } else if (args.executorPath) {
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

  // Count pass/fail across all branches
  let totalPassed = 0;
  let totalFailed = 0;
  for (const [, branchResults] of allResults) {
    for (const r of branchResults) {
      if (r.passed) totalPassed++;
      else totalFailed++;
    }
  }

  console.log(`\n[runner] Done — ${totalPassed} passed, ${totalFailed} failed.`);
  if (totalFailed > 0) {
    console.error(`[runner] ${totalFailed} scenario(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

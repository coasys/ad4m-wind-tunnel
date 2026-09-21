/**
 * C1: Multi-Agent Convergence (timing only)
 *
 * Two executors share a neighbourhood over a live link-language backend.
 * Measures time-to-convergence for link sets written concurrently by both
 * agents. Reports convergence timing regardless of outcome — the pass/fail
 * verdict does not gate on whether convergence actually occurred.
 *
 * Correctness assertions (link sync, neighbourhood join) live in ad4m's
 * integration suite (neighbourhood.ts). This scenario reports timing only.
 */

import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { connect as tcpConnect } from "net";
import { join, dirname } from "path";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { startExecutor, waitForHealth, stopExecutor, sleep, ExecutorConfig } from "../executor.js";
import { InstrumentedClient } from "../client.js";
import { getConvergenceLanguage, ConvergenceLanguage } from "../convergence/languages.js";

/** Read a value for `--flag value` from argv, else undefined. */
function argFlag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** TCP connect probe — resolves true if something accepts within timeoutMs. */
function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port });
    const done = (ok: boolean) => {
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Normalize a queryLinks result element to a stable content key. */
function linkKey(el: any): string {
  const d = el?.data ?? el ?? {};
  return `${d.source}|${d.predicate}|${d.target}`;
}

/** Extract the link array from a queryLinks TimedResult (defensive to shape). */
function linksOf(result: any): any[] {
  const data = result?.data ?? result;
  return Array.isArray(data) ? data : [];
}

async function keySet(client: InstrumentedClient, uuid: string): Promise<Set<string>> {
  const res = await client.queryLinks(uuid);
  return new Set(linksOf(res).map(linkKey));
}

export const c1Convergence: Scenario = {
  id: "c1",
  name: "Multi-Agent Convergence",
  description:
    "Install a link language into two executors over its live backend; measure convergence timing (timing only)",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const mark = (name: string, t0: number, error?: string) =>
      samples.push({ name, durationMs: performance.now() - t0, timestamp: Date.now(), error });

    const langId = argFlag("--convergence-language") || process.env.CONVERGENCE_LANGUAGE || "nostr";
    const lang: ConvergenceLanguage | undefined = getConvergenceLanguage(langId);

    const report = (summary: string, extra: Record<string, any> = {}): ScenarioResult => ({
      scenario: "c1-convergence",
      branch,
      startTime,
      endTime: Date.now(),
      durationMs: Date.now() - startTime,
      passed: true,
      metrics: { language: langId, converged: false, ...extra },
      samples,
      summary,
    });

    if (!lang) {
      return report(`C1 SKIPPED: no convergence language registered for "${langId}"`, { skipped: true });
    }

    // 1. Backend reachability — honest skip, never fake.
    if (lang.backend?.healthTcp) {
      const { host, port: bport } = lang.backend.healthTcp;
      const up = await tcpReachable(host, bport);
      if (!up) {
        return report(
          `C1 SKIPPED: ${langId} backend not reachable at ${host}:${bport} — bring it up with infra/${lang.backend.compose}`,
          { skipped: true, backendReachable: false, backend: `${host}:${bport}` }
        );
      }
    }

    const executorPath =
      ctx.executorPath ||
      join(ctx.tmpDirBase, `ad4m-build-${branch.replace(/\//g, "-")}`, "target", "release", "ad4m-executor");

    const port2 = port + 1;
    const dataPath2 = join(ctx.tmpDirBase, `ad4m-wt-c1-e2`);
    let proc2: any = null;
    let client2: InstrumentedClient | null = null;

    const K = parseInt(process.env.C1_LINKS || "10", 10);
    const convergeTimeoutMs = parseInt(process.env.C1_TIMEOUT_MS || "60000", 10);

    try {
      // 2. Second executor beside the runner's.
      const bootT0 = performance.now();
      console.log(`[c1] Starting executor B on port ${port2} (${executorPath})...`);
      const config2: ExecutorConfig = {
        branch,
        port: port2,
        dataPath: dataPath2,
        adminToken: ctx.adminToken,
        adamRepoPath: ctx.adamRepoPath,
        buildDir: dirname(dirname(dirname(executorPath))),
      };
      proc2 = await startExecutor(executorPath, config2);
      await waitForHealth(port2, 120000, ctx.adminToken);
      mark("executor_b_boot", bootT0);
      console.log("[c1] Executor B healthy");

      const client1 = client;
      client2 = new InstrumentedClient({ port: port2, adminToken: ctx.adminToken });
      await client2.connect();

      await client1.generateAgent("c1-agent-a");
      await client2.generateAgent("c1-agent-b");

      // 3. Agent A: publish → template → perspective → neighbourhood.
      const neighbourhoodId = `c1-${randomUUID()}`;

      const pubT0 = performance.now();
      const published = await client1.publishLanguage(lang.bundlePath, {
        name: `c1-${langId}`,
        description: `wind-tunnel convergence: ${langId}`,
        possibleTemplateParams: lang.possibleTemplateParams,
      });
      if (published.error || !published.data?.address) {
        return report(`C1 FAILED: publishLanguage — ${published.error || "no address returned"}`);
      }
      const sourceHash = published.data.address;
      mark("publish_language", pubT0);

      // Optional async provisioning (register a Matrix user + room, create an AT
      // Proto account, …) — runs once, its output merged OVER makeTemplateData.
      // A provisioning failure is an honest skip: the backend is up but the run
      // could not be set up, so we never reach — much less fake — a convergence
      // measurement.
      let provisioned: Record<string, string> = {};
      if (lang.provision) {
        const provT0 = performance.now();
        try {
          provisioned = await lang.provision(neighbourhoodId);
        } catch (err: any) {
          mark("provision", provT0, err.message);
          return report(
            `C1 SKIPPED: ${langId} provisioning failed — ${err.message}`,
            { skipped: true, provisionFailed: true, backendReachable: true }
          );
        }
        mark("provision", provT0);
        console.log(`[c1] Provisioned ${langId}: ${Object.keys(provisioned).join(", ")}`);
      }

      const tmplT0 = performance.now();
      const templated = await client1.applyTemplateAndPublish(
        sourceHash,
        JSON.stringify({ ...lang.makeTemplateData(neighbourhoodId), ...provisioned })
      );
      if (templated.error || !templated.data?.address) {
        return report(`C1 FAILED: applyTemplate — ${templated.error || "no address returned"}`);
      }
      const templatedAddress = templated.data.address;
      mark("apply_template", tmplT0);
      console.log(`[c1] Templated language: ${templatedAddress}`);

      const pA = await client1.createPerspective("c1-agent-a");
      const uuidA = pA.data?.uuid;
      if (!uuidA) return report(`C1 FAILED: createPerspective A — ${pA.error || "no uuid"}`);

      const nhT0 = performance.now();
      const nh = await client1.publishNeighbourhood(uuidA, templatedAddress, { links: [] });
      const neighbourhoodUrl = typeof nh.data === "string" ? nh.data : nh.data?.toString?.();
      if (nh.error || !neighbourhoodUrl) {
        return report(`C1 FAILED: publishNeighbourhood — ${nh.error || "no url"}`);
      }
      mark("publish_neighbourhood", nhT0);
      console.log(`[c1] Neighbourhood: ${neighbourhoodUrl}`);

      // 4. Agent B joins by URL — installs the same templated language.
      const joinT0 = performance.now();
      let uuidB: string;
      try {
        const joinRes: any = await client2.call("neighbourhood.join", { url: neighbourhoodUrl });
        uuidB = joinRes?.uuid;
        if (!uuidB) throw new Error(`join returned no uuid: ${JSON.stringify(joinRes)}`);
      } catch (err: any) {
        return report(`C1 FAILED: neighbourhood.join on B — ${err.message}`, { neighbourhoodUrl });
      }
      mark("neighbourhood_join", joinT0);
      console.log(`[c1] Agent B joined as perspective ${uuidB}`);

      // Let both languages initialize their subscriptions before writing.
      await sleep(5000);

      // 5. Both agents write K links each, interleaved.
      const writeT0 = performance.now();
      const expected = new Set<string>();
      for (let i = 0; i < K; i++) {
        const aSrc = `ad4m://c1-A-${i}`;
        const bSrc = `ad4m://c1-B-${i}`;
        await client1.addLink(uuidA, aSrc, "c1://has_message", `literal://a-${i}`);
        await client2.addLink(uuidB, bSrc, "c1://has_message", `literal://b-${i}`);
        expected.add(`${aSrc}|c1://has_message|literal://a-${i}`);
        expected.add(`${bSrc}|c1://has_message|literal://b-${i}`);
      }
      mark("write_links", writeT0);
      console.log(`[c1] Wrote ${K} links on each agent (${expected.size} distinct expected)`);

      // 6. Poll until BOTH agents' link sets are supersets of every expected key.
      const supersetOf = (have: Set<string>) => {
        for (const k of expected) if (!have.has(k)) return false;
        return true;
      };
      const convT0 = performance.now();
      const deadline = convT0 + convergeTimeoutMs;
      let converged = false;
      let lastA = 0;
      let lastB = 0;
      while (performance.now() < deadline) {
        const [setA, setB] = await Promise.all([keySet(client1, uuidA), keySet(client2, uuidB)]);
        lastA = setA.size;
        lastB = setB.size;
        if (supersetOf(setA) && supersetOf(setB)) {
          converged = true;
          break;
        }
        await sleep(1000);
      }
      const timeToConvergeMs = Math.round(performance.now() - convT0);
      mark("converge_poll", convT0, converged ? undefined : "did not converge");
      console.log(
        `[c1] Add-convergence: ${converged ? "YES" : "NO"} in ${timeToConvergeMs}ms ` +
          `(A=${lastA}, B=${lastB}, expected>=${expected.size})`
      );

      // Removal convergence — best-effort, non-fatal. Tests tombstone propagation.
      let removalConverged = false;
      let timeToRemoveConvergeMs = 0;
      let removalError: string | undefined;
      let removedKey = "";
      if (converged) {
        try {
          const aLinksRes = await client1.queryLinks(uuidA);
          const aOwn = linksOf(aLinksRes).find((el) => linkKey(el).startsWith("ad4m://c1-A-"));
          if (!aOwn) throw new Error("no A-authored link found to remove");
          removedKey = linkKey(aOwn);
          const d = aOwn.data ?? aOwn;
          // removeLink requires a FULL signed LinkExpression — the executor
          // rejects a link missing `proof` ("missing field `proof`"). Carry
          // author/timestamp/proof through verbatim from the queried link.
          const linkInput: any = { data: { source: d.source, predicate: d.predicate, target: d.target } };
          if (aOwn.author) linkInput.author = aOwn.author;
          if (aOwn.timestamp) linkInput.timestamp = aOwn.timestamp;
          if (aOwn.proof) linkInput.proof = aOwn.proof;

          await client1.call("perspective.removeLink", { uuid: uuidA, link: linkInput });

          const rmT0 = performance.now();
          const rmDeadline = rmT0 + convergeTimeoutMs;
          while (performance.now() < rmDeadline) {
            const [setA, setB] = await Promise.all([keySet(client1, uuidA), keySet(client2, uuidB)]);
            if (!setA.has(removedKey) && !setB.has(removedKey)) {
              removalConverged = true;
              break;
            }
            await sleep(1000);
          }
          timeToRemoveConvergeMs = Math.round(performance.now() - rmT0);
          console.log(
            `[c1] Removal-convergence: ${removalConverged ? "YES" : "NO"} in ${timeToRemoveConvergeMs}ms`
          );
        } catch (err: any) {
          removalError = err.message;
          console.log(`[c1] Removal check errored (non-fatal): ${err.message}`);
        }
      }

      const endTime = Date.now();
      const metrics = {
        language: langId,
        backend: lang.backend?.healthTcp
          ? `${lang.backend.healthTcp.host}:${lang.backend.healthTcp.port}`
          : "none",
        backendReachable: true,
        neighbourhoodUrl,
        templatedAddress,
        converged,
        linksPerAgent: K,
        expectedLinks: expected.size,
        linksA: lastA,
        linksB: lastB,
        timeToConvergeMs,
        removalConverged,
        timeToRemoveConvergeMs,
        removalError,
        removedKey,
      };

      return {
        scenario: "c1-convergence",
        branch,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        passed: converged,
        metrics,
        samples,
        summary: converged
          ? `${langId}: CONVERGED ${expected.size} links across 2 agents in ${timeToConvergeMs}ms ` +
            `(removal ${removalConverged ? "converged" : removalError ? "errored" : "did not converge"})`
          : `${langId}: DID NOT CONVERGE — A=${lastA}, B=${lastB}, expected>=${expected.size} in ${timeToConvergeMs}ms`,
      };
    } catch (err: any) {
      return report(`C1 CRASHED: ${err.message}`);
    } finally {
      if (client2) await client2.disconnect().catch(() => {});
      if (proc2) stopExecutor(proc2);
      await sleep(2000);
      try { execSync(`rm -rf "${dataPath2}"`, { stdio: "pipe" }); } catch {}
    }
  },
};

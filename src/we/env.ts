/**
 * Where U1 finds WE, the devtools, the speech clip and a browser — and what is missing if it cannot.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

export interface WeEnv {
  weRepo: string;
  weWebDir: string;
  viteBin: string;
  /** ad4m-connect namespaces its localStorage keys with its own package version. */
  connectVersion: string;
  devtoolsRepo: string;
  speechAudio: string;
  speechText: string;
  ffmpeg: string;
  /** Undefined means Playwright's own Chromium (`npx playwright-core install chromium`). */
  chrome?: string;
  whisperModel: string;
  transcribeSeconds: number;
  headed: boolean;
}

const CHROMES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** A checkout beside this repo's own, wherever the runner was started from. */
const sibling = (name: string) => fileURLToPath(new URL(`../../../${name}`, import.meta.url));

function runs(bin: string, arg: string): boolean {
  try {
    execFileSync(bin, [arg], { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

export function resolveWeEnv(adamRepoPath: string): { env: WeEnv; missing: string[] } {
  const missing: string[] = [];

  const weRepo = resolve(process.env.WE_REPO ?? sibling("we"));
  const weWebDir = join(weRepo, "apps", "we-web");
  const viteBin = join(weWebDir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) missing.push(`WE dependencies are not installed — run \`pnpm install\` in ${weRepo} (or set WE_REPO)`);
  if (!existsSync(join(weRepo, "packages", "app-shell", "dist", "shared", "index.js"))) {
    missing.push(`WE packages are not built — run \`pnpm setup-workspace\` in ${weRepo}`);
  }
  const connectPkg = join(weWebDir, "node_modules", "@coasys", "ad4m-connect", "package.json");
  const connectVersion = existsSync(connectPkg) ? JSON.parse(readFileSync(connectPkg, "utf8")).version : "";

  const devtoolsRepo = resolve(process.env.AD4M_DEVTOOLS ?? sibling("ad4m-devtools"));
  if (!existsSync(join(devtoolsRepo, "packages", "extension", "src", "extension", "page-inject.ts"))) {
    missing.push(`ad4m-devtools not found at ${devtoolsRepo} (set AD4M_DEVTOOLS)`);
  }

  const speechAudio = resolve(
    process.env.U1_SPEECH_AUDIO ?? join(adamRepoPath || sibling("ad4m"), "tests", "transcription_test.m4a"),
  );
  if (!existsSync(speechAudio)) missing.push(`speech clip not found at ${speechAudio} (set U1_SPEECH_AUDIO or AD4M_REPO)`);

  const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
  if (!runs(ffmpeg, "-version")) missing.push(`ffmpeg not found (install it or set FFMPEG) — it turns the speech clip into Chrome's fake microphone`);

  const chrome = process.env.U1_CHROME ?? CHROMES.find((p) => existsSync(p));

  return {
    missing,
    env: {
      weRepo,
      weWebDir,
      viteBin,
      connectVersion,
      devtoolsRepo,
      speechAudio,
      speechText: process.env.U1_SPEECH_TEXT ?? "If you can read this, transcription is working.",
      ffmpeg,
      chrome,
      // What WE's transcribe panel offers to install, so the node looks like one set up from WE.
      whisperModel: process.env.U1_WHISPER_MODEL ?? "whisper_small",
      transcribeSeconds: Number(process.env.U1_TRANSCRIBE_SECONDS ?? 60),
      headed: process.env.U1_HEADED === "1",
    },
  };
}

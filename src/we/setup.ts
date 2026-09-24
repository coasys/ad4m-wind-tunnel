/**
 * What an operator does before anyone opens WE: install a speech model, create a user.
 */

import { randomUUID } from "crypto";
import type { InstrumentedClient } from "../client.js";
import { sleep } from "../executor.js";

const TRANSCRIPTION = "TRANSCRIPTION";

interface ModelRow {
  id: string;
  name: string;
  modelType?: string;
}

interface LoadingStatus {
  progress?: number;
  status?: string;
  downloaded?: boolean;
  loaded?: boolean;
}

/**
 * Registers a Whisper model the way WE's "Add a model" does, then waits until its weights are on
 * disk. `ai.addModel` answers only after the download, which outlasts any RPC timeout on a first
 * run, so the row's loading status decides instead — as it does for WE. Returns the model id.
 */
export async function installTranscriptionModel(
  client: InstrumentedClient,
  fileName: string,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<string> {
  const transcriptionModels = async () =>
    ((await client.call<ModelRow[]>("ai.models")) ?? []).filter((m) => m.modelType === TRANSCRIPTION);

  let refused: Error | undefined;
  if ((await transcriptionModels()).length === 0) {
    client
      // `type` on the wire: the SDK renames WE's `modelType` to it (`AIClient.serializeModelInput`).
      .call("ai.addModel", { model: { name: `Whisper (${fileName})`, local: { fileName }, type: TRANSCRIPTION } })
      .catch((e: Error) => {
        if (!/timed out/.test(e.message)) refused = e;
      });
  }

  const deadline = Date.now() + timeoutMs;
  let id = "";
  let lastLog = 0;
  while (Date.now() < deadline) {
    if (refused) throw new Error(`ai.addModel refused: ${refused.message}`);
    id ||= (await transcriptionModels())[0]?.id ?? "";
    if (id) {
      const status = await client.call<LoadingStatus>("ai.modelLoadingStatus", { model: id }).catch(() => null);
      if (status?.downloaded || status?.loaded) return id;
      if (Date.now() - lastLog > 15000) {
        log(`Whisper ${fileName}: ${status?.status ?? "registering"} ${Math.round(status?.progress ?? 0)}%`);
        lastLog = Date.now();
      }
    }
    await sleep(1000);
  }
  throw new Error(`Whisper ${fileName} was not ready within ${timeoutMs / 1000}s`);
}

/** A fresh user on the multi-user executor, and the JWT WE will run as. */
export async function createTestUser(client: InstrumentedClient): Promise<{ email: string; token: string }> {
  const email = `u1-${randomUUID().slice(0, 8)}@wind-tunnel.test`;
  const password = randomUUID();
  await client.call("user.create", { email, password });
  const token = await client.call<string>("user.login", { email, password });
  if (typeof token !== "string" || !token) throw new Error(`user.login returned no token for ${email}`);
  return { email, token };
}

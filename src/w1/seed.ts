/**
 * W1 helper: seed a populated WE space, reproducibly, without counting it in the measurement.
 *
 * Two halves, each through WE's own code:
 *
 * 1. **The space** is created by driving WE's UI (`createSpaceViaUi`): name prompt → rail "+" →
 *    "Create a space" → name → Personal/Shared → Create. That runs `SpaceStore.createSpace` exactly as a
 *    person would: dataset, neighbourhood publish (shared), Space SDNA, the `Space` record, the space
 *    collection (`Space.root`) and the deployment's starter records (Like signal type, task states,
 *    involvement types — `we-seed.json` → `spaceStarters[0]`).
 *
 * 2. **The content** (`seedContent`) is written in Node through WE's own packages, loaded from the WE
 *    checkout: `@we/backend-ad4m` `createAd4mBackendPorts` (registers WE's model classes),
 *    `@we/block-shared` `createBlocks` (the function `SpaceStore.createPost` calls for a message or a
 *    reply), and the entity classes for channels, signals, tasks and events, with the same `parent`
 *    options SpaceStore uses. Shapes are therefore WE's; only *who* calls them differs (a script, not
 *    the composer). Content is deterministic: fixed timestamps, a seeded word generator.
 *
 * Size knobs (env): W1_CHANNELS, W1_MESSAGES (per channel), W1_REPLY_EVERY / W1_REPLIES,
 * W1_SIGNAL_EVERY, W1_TASKS, W1_EVENTS. See README.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import type { Page } from "playwright-core";

export interface SeedSize {
  channels: number;
  messagesPerChannel: number;
  /** Every Nth message gets `replies` replies (0 = none). */
  replyEvery: number;
  replies: number;
  /** Every Nth message gets a Like (0 = none). */
  signalEvery: number;
  tasks: number;
  events: number;
}

export interface SeedResult {
  spaceUuid: string;
  sharedUrl: string | null;
  spaceRecordId: string;
  rootId: string;
  channelIds: string[];
  channelTitles: string[];
  messages: number;
  replies: number;
  signals: number;
  tasks: number;
  taskTitles: string[];
  events: number;
  durationMs: number;
}

// ─── deterministic text ────────────────────────────────────────────────────────

const WORDS = (
  "map survey sheet county river ridge contour legend scale compass bearing north valley fell " +
  "trail archive print engraving folding case edition margin grid datum benchmark triangulation " +
  "meeting draft review plan budget timeline volunteer garden library kitchen workshop schedule " +
  "photo walk route bridge harbour lighthouse coast island ferry market square station tower"
).split(" ");

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function sentence(next: () => number, min = 6, max = 22): string {
  const n = min + Math.floor(next() * (max - min));
  const words = Array.from({ length: n }, () => WORDS[Math.floor(next() * WORDS.length)]);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

/** Portable Text paragraphs — what WE's composer hands `createBlocks`. */
function paragraphs(texts: string[]) {
  return texts.map((text) => ({
    _type: "block",
    style: "normal",
    children: [{ _type: "span", text, marks: [] }],
    markDefs: [],
  }));
}

// ─── UI: create the space through WE ──────────────────────────────────────────

/**
 * Drive WE's first-run name prompt (if shown) and "Create a space". Returns once the dataset exists
 * and the modal has closed. `page` must already be on the WE app with a session.
 */
export async function createSpaceViaUi(
  page: Page,
  opts: { spaceName: string; agentName: string; access: "shared" | "personal"; timeoutMs?: number },
): Promise<void> {
  const timeout = opts.timeoutMs ?? 180_000;
  // First run on a fresh agent: "What should we call you?" (apps/we-web name prompt).
  const nameInput = page.locator('input[placeholder="Name..."]');
  try {
    await nameInput.waitFor({ state: "visible", timeout: 60_000 });
    await nameInput.fill(opts.agentName);
    await page.getByText("Save", { exact: true }).click();
    await nameInput.waitFor({ state: "hidden", timeout: 30_000 });
  } catch {
    // No prompt: the agent already has a profile name.
  }

  // The rail opens on hover; its Spaces group carries the "+" (Sidebar.schema.ts, `Add a space`).
  await page.mouse.move(40, 400);
  const add = page.locator('[aria-label="Add a space"]').first();
  await add.waitFor({ state: "visible", timeout: 30_000 });
  await add.click();
  await page.getByText("Create a space", { exact: true }).click();
  await page.mouse.move(720, 450);

  const modal = page.locator("we-modal").filter({ has: page.locator('input[placeholder="Space name..."]') });
  await modal.locator('input[placeholder="Space name..."]').fill(opts.spaceName);
  if (opts.access === "shared") {
    // The Personal/Shared switch is the first switch in the modal; its labels intercept the pointer.
    const shareable = modal.getByText("Shareable space");
    for (let attempt = 0; attempt < 4 && !(await shareable.isVisible()); attempt++) {
      await modal.getByRole("switch").first().click({ force: true });
      await shareable.waitFor({ timeout: 3_000 }).catch(() => {});
    }
    await shareable.waitFor({ timeout: 5_000 });
  }
  await modal.getByText("Create Space", { exact: true }).click();
  await modal.waitFor({ state: "hidden", timeout: timeout });
}

// ─── Node: write the content through WE's packages ────────────────────────────

/** Import a built WE package's ESM entry by path, so its own imports resolve inside the WE tree. */
async function importWe(weRepo: string, rel: string): Promise<any> {
  const path = join(weRepo, rel);
  if (!existsSync(path)) throw new Error(`w1 seed: ${path} missing — run \`pnpm build:web\` in the WE checkout`);
  return import(pathToFileURL(path).href);
}

/** `@coasys/ad4m` as `@we/backend-ad4m` resolves it, so model classes and client are one instance. */
async function importWeSdk(weRepo: string): Promise<any> {
  const dir = join(weRepo, "packages", "backend-system", "ad4m", "node_modules", "@coasys", "ad4m");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return import(pathToFileURL(join(dir, pkg.module ?? pkg.main)).href);
}

function idOf(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && "id" in (value as any)) return String((value as any).id ?? "");
  return "";
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * Retry a composition write that timed out. Safe: `createBlocks` uploads the editor-state file
 * *before* it opens its write batch, so a timed-out upload wrote no record (at worst an orphan blob).
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i >= attempts || !/timed out|408/.test(String(err?.message ?? err))) throw err;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

export async function seedContent(opts: {
  weRepo: string;
  executorUrl: string;
  token: string;
  spaceUuid: string;
  size: SeedSize;
  /** Override `Space.defaultTemplateId` (e.g. "discord"); empty = keep the starter's. */
  templateId?: string;
  /** Messages (real path) or batches (pooled path) in flight (W1_SEED_CONCURRENCY). */
  concurrency?: number;
  /** Messages written through createBlocks with their own upload; the rest reuse their bodies (W1_DISTINCT_BODIES, 0 = all real). */
  distinctBodies?: number;
  /** Pooled messages per write batch (W1_SEED_BATCH). */
  batchSize?: number;
  log?: (line: string) => void;
}): Promise<SeedResult> {
  const log = opts.log ?? ((l: string) => console.log(`[w1:seed] ${l}`));
  const t0 = Date.now();
  const { Ad4mClient } = await importWeSdk(opts.weRepo);
  const backend = await importWe(opts.weRepo, "packages/backend-system/ad4m/dist/index.js");
  const entities = await importWe(opts.weRepo, "packages/entities/dist/index.js");
  const blocks = await importWe(opts.weRepo, "packages/block-system/shared/dist/index.js");

  const client = new Ad4mClient(opts.executorUrl, opts.token);
  try {
    const me = await client.agent.me();
    const ports = backend.createAd4mBackendPorts(client, { selfId: () => me.did });
    blocks.registerCoreBlocks();
    const getEntity = entities.getEntity as (name: string) => any;

    const ref = await ports.lifecycle.get(opts.spaceUuid);
    if (!ref) throw new Error(`w1 seed: no dataset ${opts.spaceUuid}`);
    const handle = ref.handle;

    // The Space record and its collection, as SpaceStore.writeSpaceStructure left them.
    const spaces = await getEntity("Space").findAll(handle, { include: { root: true } });
    const space = spaces[0];
    if (!space) throw new Error("w1 seed: the dataset has no Space record — did WE finish creating it?");
    let rootId = idOf(space.root);
    if (!rootId) {
      const roots = await getEntity("CollectionBlock").findAll(handle, { where: { kind: "channel", mode: "feed" } });
      rootId = idOf(roots.find((r: any) => !r.title)) || idOf(roots[0]);
    }
    if (!rootId) throw new Error("w1 seed: the space has no root collection");
    log(`space ${space.id} root ${rootId}`);

    if (opts.templateId) {
      await getEntity("Space").update(handle, space.id, { defaultTemplateId: opts.templateId });
      log(`defaultTemplateId → ${opts.templateId}`);
    }

    const signalTypes = await getEntity("SignalType").findAll(handle);
    const like = signalTypes.find((t: any) => t.slug === "like") ?? signalTypes[0];
    const next = rng(0x5eed);
    const base = Date.parse("2026-08-01T09:00:00.000Z");
    const anchorIn = (id: string) => ({ id, relation: "children", entity: "CollectionBlock" });

    // Channels: feed collections inside the space collection (SpaceStore record.create shape).
    const channelIds: string[] = [];
    const channelTitles: string[] = [];
    for (let c = 0; c < opts.size.channels; c++) {
      const title = c === 0 ? "general" : `channel-${c + 1}`;
      const channel = await getEntity("CollectionBlock").create(
        handle,
        { kind: "channel", mode: "feed", title, description: sentence(next, 4, 10) },
        { parent: anchorIn(rootId) },
      );
      channelIds.push(channel.id);
      channelTitles.push(title);
    }
    log(`${channelIds.length} channels`);

    // Messages and replies via createBlocks — what SpaceStore.createPost does for the composer.
    type Job = { channel: string; index: number; texts: string[]; reply: string[][]; like: boolean };
    const jobs: Job[] = [];
    for (let c = 0; c < channelIds.length; c++) {
      for (let m = 0; m < opts.size.messagesPerChannel; m++) {
        const n = jobs.length + 1;
        const texts = next() < 0.25 ? [sentence(next), sentence(next)] : [sentence(next)];
        const reply =
          opts.size.replyEvery > 0 && n % opts.size.replyEvery === 0
            ? Array.from({ length: opts.size.replies }, () => [sentence(next, 3, 12)])
            : [];
        jobs.push({ channel: channelIds[c], index: m, texts, reply, like: opts.size.signalEvery > 0 && n % opts.size.signalEvery === 0 && !!like });
      }
    }
    let messages = 0;
    let replies = 0;
    let signals = 0;
    const { LinkQuery } = await importWeSdk(opts.weRepo);
    const linksFrom = (source: string) => client.perspective.queryLinks(opts.spaceUuid, new LinkQuery({ source }));
    const progress = () => {
      if (messages % 50 === 0) log(`${messages}/${jobs.length} messages (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    };

    /*
      Two paths, both ending in the same records.

      Real: `createBlocks`, exactly as SpaceStore.createPost. Each one uploads its editor state to the
      file-storage language — two holochain zome calls, serialised per language, ~1.4 s a message.

      Pooled (all but the first `distinctBodies` messages/replies): the same model calls inside one
      write batch per `batchSize` messages — the root `CollectionBlock` with its kind, mode and
      `textContent`, one `TextBlock` per paragraph contained by it — and the root's `we://editor_state`
      link pointing at the file a real message already uploaded. The clone is a copy of that real
      message's content, so its blob and its TextBlocks agree; only the upload is skipped. The first
      clone of each kind is checked link-for-link (predicates) against its exemplar.
    */
    const distinct = opts.distinctBodies ?? 24;
    type Body = { editorState: string; textContent: string; paragraphs: { text: string; style: string }[] };
    const readBody = async (id: string): Promise<Body> => {
      const root = await getEntity("CollectionBlock").findOne(handle, { where: { id } });
      const editorState = (await linksFrom(id)).find((l: any) => l.data.predicate === "we://editor_state")?.data.target;
      if (!root || !editorState) throw new Error(`w1 seed: exemplar ${id} has no stored editor state`);
      const paragraphs: Body["paragraphs"] = [];
      for (const child of root.children ?? []) {
        const tb = await getEntity("TextBlock").findOne(handle, { where: { id: idOf(child) } });
        if (tb) paragraphs.push({ text: tb.text, style: tb.style || "normal" });
      }
      return { editorState, textContent: root.textContent ?? "", paragraphs };
    };
    // Relations to *other* records depend on the job (replies, likes), not on the record's shape;
    // they are counted perspective-wide after seeding instead.
    const perJob = new Set(["we://response", "we://thread", "we://signal"]);
    const predicateShape = async (id: string) => {
      const own = (await linksFrom(id)).map((l: any) => l.data.predicate).filter((p: string) => !perJob.has(p)).sort();
      const root = await getEntity("CollectionBlock").findOne(handle, { where: { id } });
      const first = idOf((root?.children ?? [])[0]);
      const child = first ? (await linksFrom(first)).map((l: any) => l.data.predicate).sort() : [];
      return JSON.stringify({ own, child });
    };

    const messageBodies: { id: string; body: Body }[] = [];
    const replyBodies: { id: string; body: Body }[] = [];
    const realJobs = distinct > 0 ? jobs.filter((_, i) => i % Math.max(1, Math.floor(jobs.length / distinct)) === 0).slice(0, distinct) : jobs;
    // The pool needs a reply body too, so at least one real message must carry replies.
    const firstWithReplies = jobs.find((j) => j.reply.length > 0);
    if (distinct > 0 && firstWithReplies && !realJobs.some((j) => j.reply.length > 0)) realJobs.push(firstWithReplies);
    const realSet = new Set(realJobs);
    const withThread = async (messageId: string, replyId: string) =>
      // completeResponse (app-shell shared/responses.ts): link the reply into its thread.
      getEntity("CollectionBlock").addRelation(handle, messageId, "thread", replyId);

    // Real path, `concurrency` in flight.
    await pool(realJobs, Math.max(1, opts.concurrency ?? 6), async (job) => {
      const message = await withRetry<any>(() =>
        blocks.createBlocks(handle, paragraphs(job.texts), { kind: "message", anchor: anchorIn(job.channel) }),
      );
      messages++;
      if (distinct > 0) messageBodies.push({ id: message.id, body: await readBody(message.id) });
      for (const r of job.reply) {
        const reply = await withRetry<any>(() =>
          blocks.createBlocks(handle, paragraphs(r), { kind: "reply", anchor: { id: message.id, relation: "responses" } }),
        );
        await withThread(message.id, reply.id);
        replies++;
        if (distinct > 0 && replyBodies.length < distinct) replyBodies.push({ id: reply.id, body: await readBody(reply.id) });
      }
      if (job.like) {
        await getEntity("Signal").create(handle, { signalTypeId: like.id, value: 1 }, { parent: { id: message.id, relation: "signals" } });
        signals++;
      }
      progress();
    });
    log(`${messages} messages and ${replies} replies through createBlocks (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

    // Pooled path, one write batch per `batchSize` messages.
    const cloneInto = async (
      kind: "message" | "reply",
      body: Body,
      parent: { id: string; relation: string; entity?: string },
      batchId: string,
    ) => {
      const root = await getEntity("CollectionBlock").create(
        handle,
        { kind, mode: "document", textContent: body.textContent },
        { parent, batchId },
      );
      for (const p of body.paragraphs) {
        const tb = await getEntity("TextBlock").create(handle, { style: p.style, text: p.text }, { batchId });
        await root.addChildren(tb.id, batchId);
      }
      await handle.add({ source: root.id, predicate: "we://editor_state", target: body.editorState }, "shared", batchId);
      return root.id as string;
    };
    const rest = jobs.filter((j) => !realSet.has(j));
    const batchSize = Math.max(1, opts.batchSize ?? 25);
    const batches: Job[][] = [];
    for (let i = 0; i < rest.length; i += batchSize) batches.push(rest.slice(i, i + batchSize));
    const checked = { message: false, reply: false };
    let pick = 0;
    await pool(batches, Math.max(1, opts.concurrency ?? 6), async (batch) => {
      const threads: [string, string][] = [];
      const made: { kind: "message" | "reply"; id: string; exemplar: string }[] = [];
      await entities.runEntityTransaction(handle, async (tx: { batchId?: string }) => {
        for (const job of batch) {
          const m = messageBodies[pick++ % messageBodies.length];
          const messageId = await cloneInto("message", m.body, anchorIn(job.channel), tx.batchId!);
          made.push({ kind: "message", id: messageId, exemplar: m.id });
          for (let r = 0; r < job.reply.length; r++) {
            const rb = replyBodies[(pick + r) % replyBodies.length];
            const replyId = await cloneInto("reply", rb.body, { id: messageId, relation: "responses" }, tx.batchId!);
            threads.push([messageId, replyId]);
            made.push({ kind: "reply", id: replyId, exemplar: rb.id });
          }
          if (job.like) {
            await getEntity("Signal").create(
              handle,
              { signalTypeId: like.id, value: 1 },
              { parent: { id: messageId, relation: "signals" }, batchId: tx.batchId },
            );
          }
        }
      });
      for (const [m, r] of threads) await withThread(m, r);
      for (const job of batch) {
        messages++;
        replies += job.reply.length;
        if (job.like) signals++;
        progress();
      }
      for (const kind of ["message", "reply"] as const) {
        const first = made.find((x) => x.kind === kind);
        if (first && !checked[kind]) {
          checked[kind] = true;
          const [a, b] = [await predicateShape(first.exemplar), await predicateShape(first.id)];
          if (a !== b) throw new Error(`w1 seed: pooled ${kind} differs from its createBlocks exemplar\n exemplar ${a}\n clone    ${b}`);
        }
      }
    });

    // Tasks and events in the space collection, where extraction puts them and Workshop reads them.
    const states = ["todo", "doing", "done"];
    const taskTitles: string[] = [];
    for (let i = 0; i < opts.size.tasks; i++) {
      const title = `${sentence(next, 3, 6).replace(/\.$/, "")} #${i + 1}`;
      taskTitles.push(title);
      await getEntity("TaskBlock").create(
        handle,
        { title, description: sentence(next), status: states[i % 3] },
        { parent: anchorIn(rootId) },
      );
    }
    for (let i = 0; i < opts.size.events; i++) {
      const start = new Date(base + (i * 2 + 1) * 86_400_000 + 14 * 3_600_000).toISOString().slice(0, 16);
      await getEntity("EventBlock").create(
        handle,
        { title: sentence(next, 2, 5).replace(/\.$/, ""), description: sentence(next), startDate: start, allDay: false },
        { parent: anchorIn(rootId) },
      );
    }
    log(`${opts.size.tasks} tasks, ${opts.size.events} events`);

    // Verify containment: every channel holds every message written into it.
    const containment = backend.AD4M_CONTAINMENT_PREDICATE ?? "ad4m://has_child";
    for (const id of channelIds) {
      const links = await client.perspective.queryLinks(opts.spaceUuid, new LinkQuery({ source: id, predicate: containment }));
      if (links.length !== opts.size.messagesPerChannel) {
        throw new Error(`w1 seed: channel ${id} holds ${links.length} children, expected ${opts.size.messagesPerChannel}`);
      }
    }
    const countPredicate = async (predicate: string) =>
      (await client.perspective.queryLinks(opts.spaceUuid, new LinkQuery({ predicate }))).length;
    for (const [predicate, expected] of [
      ["we://response", replies],
      ["we://thread", replies],
      ["we://signal", signals],
    ] as const) {
      const n = await countPredicate(predicate);
      if (n !== expected) throw new Error(`w1 seed: ${n} ${predicate} links, expected ${expected}`);
    }
    log(`verified ${channelIds.length} channels × ${opts.size.messagesPerChannel} messages, ${replies} replies, ${signals} likes`);

    const perspective = await client.perspective.byUUID(opts.spaceUuid);
    return {
      spaceUuid: opts.spaceUuid,
      sharedUrl: perspective?.sharedUrl ?? null,
      spaceRecordId: space.id,
      rootId,
      channelIds,
      channelTitles,
      messages,
      replies,
      signals,
      tasks: opts.size.tasks,
      taskTitles,
      events: opts.size.events,
      durationMs: Date.now() - t0,
    };
  } finally {
    client.close?.();
  }
}

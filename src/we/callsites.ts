/**
 * Where in WE a call came from: the first few WE frames of the stack the devtools captured, mapped
 * back through source maps. V8 stacks name the served file — Vite's transformed module or a
 * package's `dist` bundle — so without the maps a line number points at generated code.
 */

import { existsSync, readFileSync } from "fs";
import { SourceMap } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "path";

const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(\S+?):(\d+):(\d+)\)?\s*$/;
/** Frames that say how a call travelled rather than who made it. */
const PLUMBING = /\/node_modules\/|\/\.vite\/deps\//;
const INLINE_MAP = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/m;

export class CallSiteResolver {
  private maps = new Map<string, Promise<{ map: SourceMap; dir: string } | null>>();

  constructor(
    private weRepo: string,
    private weOrigin: string,
    private depth = 3,
  ) {}

  /** `file:line fn ← caller:line fn …`, innermost first, or undefined when no WE frame is on the stack. */
  async resolve(stack?: string): Promise<string | undefined> {
    if (!stack) return undefined;
    const frames: string[] = [];
    for (const line of stack.split("\n")) {
      const m = line.match(FRAME);
      if (!m) continue;
      const [, fn, url, ln, col] = m;
      if (!url.startsWith(this.weOrigin) || PLUMBING.test(url)) continue;
      const frame = await this.frame(url, Number(ln), Number(col), fn);
      if (frames[frames.length - 1] !== frame) frames.push(frame);
      if (frames.length >= this.depth) break;
    }
    return frames.length ? frames.join(" ← ") : undefined;
  }

  private async frame(url: string, line: number, col: number, fn?: string): Promise<string> {
    const bare = url.replace(/[?#].*$/, "");
    let file = this.display(this.localPath(bare) ?? bare.slice(this.weOrigin.length));
    let ln = line;
    const loaded = await this.load(bare);
    const entry = loaded?.map.findEntry(line - 1, col - 1) as { originalSource?: string; originalLine?: number } | undefined;
    if (loaded && entry?.originalSource && entry.originalLine !== undefined) {
      const source = entry.originalSource.replace(/^file:\/\//, "");
      file = this.display(isAbsolute(source) ? source : resolve(loaded.dir, source));
      ln = entry.originalLine + 1;
    }
    const name = fn?.replace(/^(Object|Module)\./, "");
    return `${file}:${ln}${name ? ` ${name}` : ""}`;
  }

  /** The file on disk behind a served URL: `/@fs/<abs>` directly, anything else under we-web. */
  private localPath(bare: string): string | undefined {
    const path = decodeURIComponent(bare.slice(this.weOrigin.length));
    if (path.startsWith("/@fs/")) return path.slice("/@fs".length);
    if (path.startsWith("/@")) return undefined;
    return resolve(this.weRepo, "apps", "we-web", `.${path}`);
  }

  private display(path: string): string {
    const rel = relative(this.weRepo, path);
    return rel.startsWith("..") ? path : rel;
  }

  private load(bare: string) {
    let pending = this.maps.get(bare);
    if (!pending) {
      pending = this.fetchMap(bare).catch(() => null);
      this.maps.set(bare, pending);
    }
    return pending;
  }

  private async fetchMap(bare: string): Promise<{ map: SourceMap; dir: string } | null> {
    const local = this.localPath(bare);
    // A package's build ships its map beside it; Vite inlines one into every module it transforms.
    if (local && local.endsWith(".js") && existsSync(`${local}.map`)) {
      return { map: new SourceMap(JSON.parse(readFileSync(`${local}.map`, "utf8"))), dir: dirname(local) };
    }
    const res = await fetch(bare);
    if (!res.ok) return null;
    const inline = (await res.text()).match(INLINE_MAP);
    if (!inline) return null;
    const payload = JSON.parse(Buffer.from(inline[1], "base64").toString("utf8"));
    return { map: new SourceMap(payload), dir: local ? dirname(local) : this.weRepo };
  }
}

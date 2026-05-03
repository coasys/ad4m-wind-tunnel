/**
 * Instrumented AD4M Client
 * Supports both GraphQL (dev, sparql-1.2-cleanup) and REST (sse-to-websocket) APIs.
 */

import WebSocket from "ws";

export interface TimedResult<T> {
  data: T;
  durationMs: number;
  timestamp: number;
  error?: string;
}

export type Transport = "graphql" | "rest" | "ws";

export interface ClientConfig {
  port: number;
  host?: string;
  adminToken: string;
  transport: Transport;
}

export class InstrumentedClient {
  public readonly config: ClientConfig;
  private ws: WebSocket | null = null;
  private wsReady: Promise<void> | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();

  public metrics = {
    totalRequests: 0,
    totalErrors: 0,
    totalDurationMs: 0,
    latencies: [] as number[],
  };

  constructor(config: ClientConfig) {
    this.config = { host: "127.0.0.1", ...config };
  }

  get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  get wsUrl(): string {
    return `ws://${this.config.host}:${this.config.port}/api/v1/ws?token=${this.config.adminToken}`;
  }

  async connect(): Promise<void> {
    if (this.config.transport === "ws") {
      this.wsReady = new Promise((resolve, reject) => {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.on("open", () => resolve());
        this.ws.on("error", (err) => reject(err));
        this.ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.id) {
              const pending = this.pendingRequests.get(String(msg.id));
              if (pending) {
                this.pendingRequests.delete(String(msg.id));
                if (msg.error) {
                  pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                } else {
                  pending.resolve(msg.result);
                }
              }
            }
          } catch {}
        });
        this.ws.on("close", () => {
          for (const [, p] of this.pendingRequests) {
            p.reject(new Error("WebSocket closed"));
          }
          this.pendingRequests.clear();
        });
      });
      await this.wsReady;
    }
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async wsCall<T>(method: string, params: any): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    const id = String(++this.requestId);
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id: Number(id), method, params }));
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`WS request ${method} timed out`));
        }
      }, 30000);
    });
  }

  private async restCall<T>(method: string, path: string, body?: any): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.config.adminToken}`,
        "Content-Type": "application/json",
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  private async graphqlCall<T>(query: string, variables?: Record<string, any>): Promise<T> {
    const url = `${this.baseUrl}/graphql`;
    const body: any = { query };
    if (variables) body.variables = variables;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.config.adminToken,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
    }
    const json = await res.json() as any;
    if (json.errors && json.errors.length > 0) {
      throw new Error(`GraphQL error: ${json.errors[0].message}`);
    }
    return json.data as T;
  }

  async timed<T>(fn: () => Promise<T>): Promise<TimedResult<T>> {
    const start = performance.now();
    const timestamp = Date.now();
    this.metrics.totalRequests++;
    try {
      const data = await fn();
      const durationMs = performance.now() - start;
      this.metrics.totalDurationMs += durationMs;
      this.metrics.latencies.push(durationMs);
      return { data, durationMs, timestamp };
    } catch (err: any) {
      const durationMs = performance.now() - start;
      this.metrics.totalErrors++;
      this.metrics.totalDurationMs += durationMs;
      this.metrics.latencies.push(durationMs);
      return { data: undefined as any, durationMs, timestamp, error: err.message };
    }
  }

  // --- High-level operations ---

  async health(): Promise<TimedResult<any>> {
    if (this.config.transport === "graphql") {
      // GraphQL branches: GET / returns 200
      return this.timed(async () => {
        const res = await fetch(`${this.baseUrl}/`);
        if (!res.ok) throw new Error(`Health HTTP ${res.status}`);
        return { status: "ok" };
      });
    }
    // REST/WS branches: GET /health returns JSON
    return this.timed(async () => {
      const res = await fetch(`${this.baseUrl}/health`);
      if (!res.ok) throw new Error(`Health HTTP ${res.status}`);
      return await res.json();
    });
  }

  async generateAgent(passphrase: string): Promise<TimedResult<any>> {
    if (this.config.transport === "ws") {
      return this.timed(() => this.wsCall("agent.generate", { passphrase }));
    }
    if (this.config.transport === "rest") {
      return this.timed(() =>
        this.restCall("POST", "/api/v1/agent/generate", { passphrase })
      );
    }
    // GraphQL
    return this.timed(() =>
      this.graphqlCall(`mutation { agentGenerate(passphrase: "${passphrase}") { did isInitialized } }`)
    );
  }

  async createPerspective(name: string): Promise<TimedResult<any>> {
    if (this.config.transport === "ws") {
      return this.timed(() => this.wsCall("perspective.add", { name }));
    }
    if (this.config.transport === "rest") {
      return this.timed(() =>
        this.restCall("POST", "/api/v1/perspectives", { name })
      );
    }
    // GraphQL
    return this.timed(async () => {
      const data = await this.graphqlCall<any>(`mutation { perspectiveAdd(name: "${name}") { uuid name } }`);
      return data.perspectiveAdd;
    });
  }

  async addLink(
    perspectiveUuid: string,
    source: string,
    predicate: string,
    target: string
  ): Promise<TimedResult<any>> {
    if (this.config.transport === "ws") {
      return this.timed(() =>
        this.wsCall("perspective.add_link", {
          uuid: perspectiveUuid,
          link: { source, predicate, target },
        })
      );
    }
    if (this.config.transport === "rest") {
      return this.timed(() =>
        this.restCall("POST", `/api/v1/perspectives/${perspectiveUuid}/links`, {
          source, predicate, target,
        })
      );
    }
    // GraphQL
    return this.timed(async () => {
      const mutation = `mutation {
        perspectiveAddLink(uuid: "${perspectiveUuid}", link: {source: "${source}", predicate: "${predicate}", target: "${target}"}) {
          author { did }
          timestamp
          data { source predicate target }
        }
      }`;
      const data = await this.graphqlCall<any>(mutation);
      return data.perspectiveAddLink;
    });
  }

  async queryLinks(
    perspectiveUuid: string,
    params?: { source?: string; predicate?: string; target?: string }
  ): Promise<TimedResult<any>> {
    if (this.config.transport === "ws") {
      return this.timed(() =>
        this.wsCall("perspective.query_links", {
          uuid: perspectiveUuid,
          query: params || {},
        })
      );
    }
    if (this.config.transport === "rest") {
      const qs = new URLSearchParams();
      if (params?.source) qs.set("source", params.source);
      if (params?.predicate) qs.set("predicate", params.predicate);
      if (params?.target) qs.set("target", params.target);
      const query = qs.toString() ? `?${qs.toString()}` : "";
      return this.timed(() =>
        this.restCall("GET", `/api/v1/perspectives/${perspectiveUuid}/links${query}`)
      );
    }
    // GraphQL
    return this.timed(async () => {
      const queryParts: string[] = [];
      if (params?.source) queryParts.push(`source: "${params.source}"`);
      if (params?.predicate) queryParts.push(`predicate: "${params.predicate}"`);
      if (params?.target) queryParts.push(`target: "${params.target}"`);
      const queryArg = queryParts.length > 0 ? `query: {${queryParts.join(", ")}}` : `query: {}`;
      const gql = `query {
        perspectiveQueryLinks(uuid: "${perspectiveUuid}", ${queryArg}) {
          author { did }
          timestamp
          data { source predicate target }
        }
      }`;
      const data = await this.graphqlCall<any>(gql);
      return data.perspectiveQueryLinks;
    });
  }

  async runProlog(perspectiveUuid: string, query: string): Promise<TimedResult<any>> {
    if (this.config.transport === "ws") {
      return this.timed(() =>
        this.wsCall("perspective.query_prolog", { uuid: perspectiveUuid, query })
      );
    }
    if (this.config.transport === "rest") {
      return this.timed(() =>
        this.restCall("POST", `/api/v1/perspectives/${perspectiveUuid}/prolog`, { query })
      );
    }
    // GraphQL
    return this.timed(async () => {
      const escaped = query.replace(/"/g, '\\"');
      const gql = `query { perspectiveQueryProlog(uuid: "${perspectiveUuid}", query: "${escaped}") }`;
      const data = await this.graphqlCall<any>(gql);
      return data.perspectiveQueryProlog;
    });
  }

  resetMetrics(): void {
    this.metrics = { totalRequests: 0, totalErrors: 0, totalDurationMs: 0, latencies: [] };
  }

  getStats() {
    const sorted = [...this.metrics.latencies].sort((a, b) => a - b);
    const count = sorted.length;
    if (count === 0) {
      return { count: 0, errors: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, minMs: 0, maxMs: 0 };
    }
    return {
      count,
      errors: this.metrics.totalErrors,
      avgMs: this.metrics.totalDurationMs / count,
      p50Ms: sorted[Math.floor(count * 0.5)],
      p95Ms: sorted[Math.floor(count * 0.95)],
      p99Ms: sorted[Math.floor(count * 0.99)],
      minMs: sorted[0],
      maxMs: sorted[count - 1],
    };
  }
}

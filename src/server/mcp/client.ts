import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerStatus } from "../../shared/types.js";
import { Logger, rootLogger } from "../core/logger.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Real JSON-RPC 2.0 MCP stdio client.
 * Spawns an MCP server subprocess, negotiates `initialize`, discovers tools via `tools/list`,
 * and dispatches `tools/call` with timeout and cancellation support.
 */
export class McpStdioClient {
  readonly config: McpServerConfig;
  readonly #logger: Logger;
  #proc: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #buffer = "";
  #connected = false;
  #lastError?: string;
  #tools: McpToolDescriptor[] = [];
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(config: McpServerConfig, logger: Logger = rootLogger.child(`mcp:${config.name}`)) {
    this.config = config;
    this.#logger = logger;
  }

  get status(): McpServerStatus {
    return {
      name: this.config.name,
      command: [this.config.command, ...(this.config.args ?? [])].join(" "),
      connected: this.#connected,
      toolCount: this.#tools.length,
      error: this.#lastError,
    };
  }

  get discoveredTools(): readonly McpToolDescriptor[] {
    return this.#tools;
  }

  async connect(): Promise<readonly McpToolDescriptor[]> {
    if (this.#connected) return this.#tools;
    this.#lastError = undefined;

    const proc = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#proc = proc;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.#onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.#logger.debug("MCP stderr", { text: chunk.trim() });
    });

    proc.on("exit", (code) => {
      this.#connected = false;
      const err = new Error(`MCP server "${this.config.name}" exited (code ${code ?? "null"})`);
      for (const [, waiter] of this.#pending) {
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
      this.#pending.clear();
    });

    try {
      await this.#request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "opengpt-forge", version: "0.2.0" },
      });
      this.#notify("notifications/initialized", {});
      const listResult = (await this.#request("tools/list", {})) as { tools?: McpToolDescriptor[] };
      this.#tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
      this.#connected = true;
      this.#logger.info("MCP server connected", { server: this.config.name, tools: this.#tools.length });
      return this.#tools;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      await this.close();
      throw error;
    }
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.#connected) {
      throw new Error(`MCP server "${this.config.name}" is not connected`);
    }
    return this.#request("tools/call", { name, arguments: args ?? {} }, signal);
  }

  async close(): Promise<void> {
    this.#connected = false;
    const proc = this.#proc;
    this.#proc = null;
    for (const [, waiter] of this.#pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP server "${this.config.name}" closed`));
    }
    this.#pending.clear();
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
    }
  }

  #notify(method: string, params: Record<string, unknown>): void {
    if (!this.#proc?.stdin.writable) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.#proc.stdin.write(`${msg}\n`);
  }

  #request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.#proc?.stdin.writable) {
        return reject(new Error(`MCP server "${this.config.name}" stdin is not writable`));
      }
      const id = this.#nextId++;
      const timeoutMs = this.config.timeoutMs ?? 20_000;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request "${method}" to "${this.config.name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error(`MCP request "${method}" aborted`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(id, {
        resolve: (val) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(val);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
        timer,
      });

      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.#proc.stdin.write(`${payload}\n`);
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let idx: number;
    while ((idx = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (!line) continue;
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof parsed.id === "number") {
        const waiter = this.#pending.get(parsed.id);
        if (!waiter) continue;
        this.#pending.delete(parsed.id);
        clearTimeout(waiter.timer);
        if (parsed.error) {
          waiter.reject(new Error(`MCP error (${parsed.error.code}): ${parsed.error.message}`));
        } else {
          waiter.resolve(parsed.result);
        }
      }
    }
  }
}

/**
 * Manages configured MCP stdio servers and dynamically registers their tools into `ToolRegistry`.
 */
export class McpManager {
  readonly #clients = new Map<string, McpStdioClient>();
  readonly #disposers = new Map<string, Array<() => void>>();
  readonly #registry: ToolRegistry;
  readonly #logger: Logger;

  constructor(registry: ToolRegistry, logger: Logger = rootLogger.child("mcp")) {
    this.#registry = registry;
    this.#logger = logger;
  }

  async addServer(config: McpServerConfig): Promise<McpServerStatus> {
    if (this.#clients.has(config.name)) {
      await this.removeServer(config.name);
    }
    const client = new McpStdioClient(config, this.#logger.child(config.name));
    this.#clients.set(config.name, client);
    const disposers: Array<() => void> = [];
    this.#disposers.set(config.name, disposers);

    try {
      const tools = await client.connect();
      for (const tool of tools) {
        const safeServer = config.name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const safeTool = tool.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
        const publicName = `mcp__${safeServer}__${safeTool}`;
        const dispose = this.#registry.register({
          name: publicName,
          description: `[MCP:${config.name}] ${tool.description ?? tool.name}`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
          category: `mcp:${config.name}`,
          concurrencySafe: false,
          requiredSandboxMode: "read-only",
          source: "mcp",
          execute: (input, ctx) => client.callTool(tool.name, input, ctx.signal),
          summarize: () => `MCP ${config.name}/${tool.name} completed`,
        });
        disposers.push(dispose);
      }
    } catch (error) {
      this.#logger.warn("MCP server failed to connect", {
        server: config.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return client.status;
  }

  async removeServer(name: string): Promise<void> {
    const disposers = this.#disposers.get(name) ?? [];
    for (const dispose of disposers) dispose();
    this.#disposers.delete(name);
    const client = this.#clients.get(name);
    this.#clients.delete(name);
    if (client) await client.close();
  }

  listStatuses(): McpServerStatus[] {
    return [...this.#clients.values()].map((c) => c.status);
  }

  getPromptSummary(): string | undefined {
    const connected = this.listStatuses().filter((s) => s.connected);
    if (connected.length === 0) return undefined;
    const lines = ["## Connected MCP Servers"];
    for (const server of connected) {
      lines.push(`- ${server.name}: ${server.toolCount} tools available (prefixed \`mcp__${server.name}__\`)`);
    }
    return lines.join("\n");
  }

  async disposeAll(): Promise<void> {
    for (const name of [...this.#clients.keys()]) {
      await this.removeServer(name);
    }
  }
}

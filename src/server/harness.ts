import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderId, SandboxMode } from "../shared/types.js";
import { AgentLoop } from "./core/agent-loop.js";
import { CompactionEngine } from "./core/compaction.js";
import { Logger, rootLogger } from "./core/logger.js";
import { PluginHost, type ForgePlugin } from "./core/plugin-host.js";
import { createDefaultPromptAssembler, PromptAssembler } from "./core/prompt.js";
import { SessionStore } from "./core/session.js";
import { McpManager, type McpServerConfig } from "./mcp/client.js";
import { MemoryStore } from "./memory/store.js";
import { createDefaultProviderRegistry, ProviderRegistry } from "./providers/registry.js";
import { builtinUtilityTools } from "./tools/builtins.js";
import { filesystemTools } from "./tools/fs-tools.js";
import { createMemoryTools } from "./tools/memory-tools.js";
import { planTools } from "./tools/plan-tools.js";
import { ToolRegistry } from "./tools/registry.js";
import { repoTools } from "./tools/repo-tools.js";
import { shellTools } from "./tools/shell-tools.js";
import { createSubagentTool } from "./tools/subagent-tool.js";

export interface ForgeHarnessConfig {
  dataDir?: string;
  workspaceRoot?: string;
  defaultSandboxMode?: SandboxMode;
  maxSteps?: number;
  providers?: ProviderRegistry;
  mcpServers?: McpServerConfig[];
  plugins?: ForgePlugin[];
  logger?: Logger;
}

/**
 * Composition root for OpenGPT Forge.
 * Wires PluginHost, ProviderRegistry, SessionStore, MemoryStore, ToolRegistry,
 * CompactionEngine, PromptAssembler, McpManager, and AgentLoop into one cohesive runtime.
 */
export class ForgeHarness {
  readonly logger: Logger;
  readonly host: PluginHost;
  readonly providers: ProviderRegistry;
  readonly sessions: SessionStore;
  readonly memory: MemoryStore;
  readonly tools: ToolRegistry;
  readonly compaction: CompactionEngine;
  readonly prompt: PromptAssembler;
  readonly mcp: McpManager;
  readonly loop: AgentLoop;
  readonly workspaceRoot: string;
  readonly defaultSandboxMode: SandboxMode;

  constructor(config: ForgeHarnessConfig = {}) {
    this.logger = config.logger ?? rootLogger;
    this.workspaceRoot = path.resolve(config.workspaceRoot ?? process.env.FORGE_WORKSPACE_ROOT ?? process.cwd());
    const dataDir = path.resolve(config.dataDir ?? process.env.FORGE_DATA_DIR ?? ".forge-data");
    this.defaultSandboxMode =
      config.defaultSandboxMode ??
      ((process.env.FORGE_SANDBOX_MODE as SandboxMode | undefined) ?? "workspace-write");

    this.host = new PluginHost(this.logger.child("plugins"));
    this.providers = config.providers ?? createDefaultProviderRegistry();
    this.sessions = new SessionStore(dataDir);
    this.memory = new MemoryStore(dataDir);
    this.tools = new ToolRegistry(this.host);
    this.compaction = new CompactionEngine();
    this.mcp = new McpManager(this.tools, this.logger.child("mcp"));

    this.prompt = createDefaultPromptAssembler({
      getMemorySnippet: async () => {
        const recent = (await this.memory.list()).slice(0, 8);
        if (recent.length === 0) return undefined;
        const lines = ["## Persistent Memory (recent entries)"];
        for (const item of recent) {
          lines.push(`- **${item.key}**: ${item.content.slice(0, 200)}`);
        }
        return lines.join("\n");
      },
      getMcpInstructions: () => this.mcp.getPromptSummary(),
    });

    this.loop = new AgentLoop({
      providers: this.providers,
      tools: this.tools,
      prompt: this.prompt,
      compaction: this.compaction,
      host: this.host,
      logger: this.logger.child("agent-loop"),
      maxSteps: config.maxSteps ?? Number(process.env.FORGE_MAX_STEPS ?? 12),
    });

    // Register core services on PluginHost so external plugins can consume them
    this.host.setService("providers", this.providers);
    this.host.setService("sessions", this.sessions);
    this.host.setService("memory", this.memory);
    this.host.setService("tools", this.tools);
    this.host.setService("compaction", this.compaction);
    this.host.setService("prompt", this.prompt);
    this.host.setService("mcp", this.mcp);
    this.host.setService("loop", this.loop);

    // Register built-in tool suites
    for (const tool of [
      ...builtinUtilityTools,
      ...filesystemTools,
      ...shellTools,
      ...repoTools,
      ...planTools,
      ...createMemoryTools(this.memory),
      createSubagentTool({ getLoop: () => this.loop, sessions: this.sessions }),
    ]) {
      this.tools.register(tool);
    }
  }

  async init(options: { mcpServers?: McpServerConfig[]; plugins?: ForgePlugin[] } = {}): Promise<void> {
    for (const plugin of options.plugins ?? []) {
      await this.host.mount(plugin);
    }

    const mcpConfigs: McpServerConfig[] = [...(options.mcpServers ?? [])];
    const mcpConfigPath = process.env.FORGE_MCP_CONFIG;
    if (mcpConfigPath) {
      try {
        const raw = JSON.parse(await readFile(path.resolve(mcpConfigPath), "utf8")) as {
          servers?: McpServerConfig[];
        };
        if (Array.isArray(raw.servers)) mcpConfigs.push(...raw.servers);
      } catch (error) {
        this.logger.warn("Could not load FORGE_MCP_CONFIG", {
          path: mcpConfigPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const server of mcpConfigs) {
      await this.mcp.addServer(server);
    }
  }

  getDefaultRoute(): { provider: ProviderId; model: string } {
    const adapter = this.providers.getDefault();
    return { provider: adapter.id, model: adapter.defaultModel };
  }

  async dispose(): Promise<void> {
    await this.mcp.disposeAll();
    await this.host.disposeAll();
  }
}

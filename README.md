# OpenGPT Forge

OpenGPT Forge is an open-source, multi-provider autonomous AI agent harness inspired by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Built with a modular TypeScript architecture, it provides an event-sourced agent runtime, sandboxed workspace tools, persistent memory, MCP integration, a CLI, and a real-time streaming web workspace.

## Key Capabilities

- **Autonomous Agent Orchestration**: Turn & step loop with bounded execution, cancellation, transient error retries, context-overflow recovery, and scoped subagent delegation (`delegate_task`).
- **Multi-Provider Streaming**: First-class native streaming adapters for **DeepSeek** (including reasoning traces), **OpenAI**, **Anthropic**, **Google Gemini**, and **Local LLMs** (Ollama / LM Studio / vLLM).
- **Event-Sourced Sessions & Context Compaction**: Append-only JSONL session logs with deterministic replay, heuristic token metering, and automatic or manual compaction checkpoints.
- **Guarded Tool Pipeline**: Scoped `ToolRegistry` with allow/deny restrictions, parallel execution for concurrency-safe tools, sequential barriers for mutating tools, cooperative timeouts, and `pre-execute`/`post-execute` plugin hooks.
- **Sandboxed Execution & Workspace Awareness**: Per-session `read-only`, `workspace-write`, and `danger-full-access` modes with canonical path/symlink confinement, environment secret stripping, and built-in filesystem, repository/git, shell, and code execution tools.
- **Planning & Persistent Memory**: Logged Plan Mode, structured task lists (`manage_todos`), and durable cross-session memory (`memory_save`, `memory_search`, `memory_delete`).
- **Plugin Host & MCP Integration**: Disposable plugin lifecycle (`PluginHost`) and real JSON-RPC 2.0 stdio MCP server client (`McpManager`) for dynamic tool discovery.
- **Web UI, CLI & Docker**: Responsive dark-mode web interface, interactive/headless CLI, and container-ready `Dockerfile` + `docker-compose.yml`.

## Quick Start

Requires **Node.js 22+**.

```powershell
Copy-Item .env.example .env
# Add at least one provider API key (e.g., DEEPSEEK_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY)
# or point LOCAL_LLM_BASE_URL at Ollama (http://127.0.0.1:11434/v1)
npm install
npm run dev
```

- Web UI (dev): `http://127.0.0.1:5173`
- API Server: `http://127.0.0.1:3080`

### Production Build

```powershell
npm run build
npm start
```

Open `http://127.0.0.1:3080`.

### CLI Usage

```powershell
# List providers and configuration status
npm run cli -- models

# List all registered tools and sandbox requirements
npm run cli -- tools

# Run a one-shot autonomous agent task
npm run cli -- run "Summarize the structure of this repository" --provider deepseek --sandbox read-only

# Start an interactive terminal session
npm run cli -- chat --provider openai --model gpt-4o-mini
```

### Docker

```bash
cp .env.example .env
docker compose up --build
```

## Project Structure

```text
src/
├── shared/types.ts              # Shared wire types & StreamEvent protocol
├── server/
│   ├── core/                    # Logger, PluginHost, EventSession, CompactionEngine, PromptAssembler, AgentLoop
│   ├── providers/               # Multi-provider registry & streaming adapters (DeepSeek, OpenAI, Anthropic, Gemini, Local)
│   ├── sandbox/                 # SandboxExecutionPolicy, path/symlink confinement, sanitized command/code executor
│   ├── tools/                   # Scoped ToolRegistry + fs, shell, repo, plan, memory, subagent, utility tools
│   ├── memory/                  # Persistent cross-session MemoryStore
│   ├── mcp/                     # JSON-RPC 2.0 stdio MCP client & dynamic tool manager
│   ├── plugins/                 # Backwards-compatible legacy plugin registry & builtins
│   ├── harness.ts               # ForgeHarness composition root
│   ├── app.ts                   # Express HTTP + NDJSON streaming API
│   ├── cli.ts                   # CLI entrypoint (run, chat, models, tools)
│   └── index.ts                 # HTTP server entrypoint
└── client/                      # React + Vite web workspace
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a detailed architectural walkthrough and [examples/](examples/) for custom plugin and MCP server configurations.

## Verification

```powershell
npm run typecheck
npm test
npm run build
```

## Security Notes

- API keys stay exclusively in server environment variables and are stripped from child processes spawned by `run_command` and `run_code`.
- `read-only` mode blocks all file writes, edits, shell commands, and code execution.
- `workspace-write` confines file operations to `FORGE_WORKSPACE_ROOT` using canonical `realpath` checks and symlink escape detection.
- `danger-full-access` bypasses filesystem confinement and should only be enabled in trusted or containerized environments.

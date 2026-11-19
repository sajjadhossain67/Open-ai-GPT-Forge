# OpenGPT Forge Architecture

OpenGPT Forge is an independent, open-source autonomous AI agent harness inspired by the core architectural principles of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — specifically its plugin-oriented capability seams, event-sourced append-only session log, guarded tool execution pipeline, per-call sandbox policies, context compaction, and MCP integration.

## System Overview

```text
Web UI (React + Vite) / CLI (forge run | chat | models | tools)
                         │  HTTP + NDJSON Stream
                         ▼
          Express API Gateway (src/server/app.ts)
                         │
                         ▼
         ForgeHarness Composition Root (src/server/harness.ts)
  ┌──────────────────────┼──────────────────────┐
  ▼                      ▼                      ▼
PluginHost          AgentLoop              McpManager
(services &         (Turn/Step driver,     (JSON-RPC 2.0 stdio
 waterfall hooks)    retry, overflow        dynamic tool discovery)
                     compaction, streaming)
                         │
        ┌────────────────┼────────────────┬────────────────┐
        ▼                ▼                ▼                ▼
ProviderRegistry   SessionStore     ToolRegistry     MemoryStore
- DeepSeek         (JSONL event     - Scoped allow/  (Atomic JSON
- OpenAI            log + derived    deny             long-term
- Anthropic         LLM history +   - Parallel vs     key/tag store)
- Gemini            compaction       exclusive
- Local (Ollama)    checkpoints)    - SandboxPolicy
```

## Core Design Principles

### 1. Event-Sourced Append-Only Sessions (`src/server/core/session.ts`)
Every turn, step, user message, assistant message, tool call, tool result, plan update, and compaction checkpoint is appended as a JSON line to `<FORGE_DATA_DIR>/sessions/<id>.jsonl`.
- LLM message history is **derived** purely from the event log (`deriveLlmMessages()`).
- UI conversation views and plan states are projections over the same log (`toConversation()`, `derivePlanState()`).
- Partial trailing lines after unclean shutdowns are ignored cleanly on reload.

### 2. Turn & Step Agent Loop (`src/server/core/agent-loop.ts`)
- A **Turn** opens with `turn/start`, appends the user message, and executes bounded **Steps** (default max 12).
- Each **Step**:
  1. Checks token pressure and triggers `CompactionEngine` if needed.
  2. Runs `agent/pre-step` waterfall hooks via `PluginHost`.
  3. Assembles ordered system-prompt sections (`core:base`, `core:workspace`, `core:plan-mode`, `core:memory`, `core:mcp`) via `PromptAssembler`.
  4. Streams from the active `LlmAdapter` with automatic retry for transient 429/5xx errors and automatic forced compaction + retry on `CONTEXT_OVERFLOW`.
  5. Dispatches requested tool calls through `ToolRegistry.executeBatch()` — running consecutive `concurrencySafe` tools in parallel while treating mutating tools as sequential barriers.
  6. Loops until the model finishes without tool calls, the caller aborts, or `maxSteps` is reached.

### 3. Unified Multi-Provider Layer (`src/server/providers/`)
All providers implement `LlmAdapter` and emit normalized `LlmStreamChunk` events (`reasoning-delta`, `text-delta`, `tool-call`, `usage`, `finish`):
- **DeepSeek** (`openai-compat.ts`): Chat Completions streaming + `reasoning_content` for `deepseek-reasoner`.
- **OpenAI** (`openai-compat.ts` + preserved `openai-provider.ts`): Chat Completions streaming + legacy Responses API compatibility.
- **Anthropic** (`anthropic.ts`): Native Messages API SSE streaming with `thinking_delta`, `text_delta`, and `input_json_delta` tool-use assembly.
- **Google Gemini** (`gemini.ts`): Native `streamGenerateContent?alt=sse` with thought parts and `functionCall`/`functionResponse`.
- **Local LLMs** (`openai-compat.ts`): Ollama, LM Studio, vLLM, or any OpenAI-compatible local server without requiring an API key.

### 4. Security & Sandbox Boundaries (`src/server/sandbox/`)
- **Per-call `SandboxExecutionPolicy`**: `read-only` | `workspace-write` | `danger-full-access`.
- **Path confinement (`resolveConfinedPath`)**: Canonicalizes roots and targets with `realpath` and checks `lstat` symlinks to prevent `..` directory traversal and symlink escapes.
- **Subprocess hardening (`executor.ts`)**: Strips sensitive environment variables (`API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PRIVATE_KEY`, `CREDENTIALS`) from spawned shells/scripts, enforces strict timeouts, caps combined stdout/stderr output, and blocks destructive command patterns when confined.

### 5. Extensibility: Plugins & MCP (`src/server/core/plugin-host.ts`, `src/server/mcp/client.ts`)
- **PluginHost**: Plugins register services, tools, and waterfall/serial hooks; all effects unwind automatically on `unmount()`.
- **MCP Client**: Connects to JSON-RPC 2.0 stdio MCP servers (`initialize` -> `tools/list` -> `tools/call`) and dynamically registers discovered tools as `mcp__<server>__<tool>` in `ToolRegistry`.

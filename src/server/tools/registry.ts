import type { ToolInfo } from "../../shared/types.js";
import type { PluginHost } from "../core/plugin-host.js";
import type { LlmToolCall, LlmToolSchema } from "../providers/types.js";
import { assertModePermitted } from "../sandbox/policy.js";
import { toToolInfo, type HarnessTool, type ToolExecutionOutcome, type ToolRestriction, type ToolRunContext } from "./types.js";

const TOOL_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;
const MAX_TOOL_OUTPUT_CHARS = 32_000;

function truncateOutput(raw: string): string {
  if (raw.length <= MAX_TOOL_OUTPUT_CHARS) return raw;
  return `${raw.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...[truncated ${raw.length - MAX_TOOL_OUTPUT_CHARS} chars]`;
}

/**
 * Scoped Tool Registry & Guarded Execution Pipeline inspired by DeepSeek Harness's `ctx.tools`.
 * - Separates model-facing JSON schemas from host-only execution metadata.
 * - Enforces sandbox modes, timeouts, and allow/deny restrictions.
 * - Dispatches concurrency-safe tool calls in parallel and exclusive calls sequentially.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, HarnessTool>();
  readonly #host?: PluginHost;

  constructor(host?: PluginHost) {
    this.#host = host;
  }

  register(tool: HarnessTool): () => void {
    if (!TOOL_NAME_REGEX.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`);
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
    return () => {
      if (this.#tools.get(tool.name) === tool) {
        this.#tools.delete(tool.name);
      }
    };
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  get(name: string): HarnessTool | undefined {
    return this.#tools.get(name);
  }

  all(restriction?: ToolRestriction): HarnessTool[] {
    let tools = [...this.#tools.values()];
    if (restriction?.allow) {
      const allowed = new Set(restriction.allow);
      tools = tools.filter((t) => allowed.has(t.name));
    }
    if (restriction?.deny) {
      const denied = new Set(restriction.deny);
      tools = tools.filter((t) => !denied.has(t.name));
    }
    return tools;
  }

  listInfo(restriction?: ToolRestriction): ToolInfo[] {
    return this.all(restriction).map(toToolInfo);
  }

  /**
   * Builds model-facing tool schemas via explicit allowlist so host metadata never leaks.
   */
  schemas(restriction?: ToolRestriction): LlmToolSchema[] {
    return this.all(restriction).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async executeSingle(
    call: LlmToolCall,
    context: Omit<ToolRunContext, "callId">,
    restriction?: ToolRestriction,
  ): Promise<ToolExecutionOutcome> {
    const start = Date.now();
    const visible = this.all(restriction);
    const tool = visible.find((item) => item.name === call.name);

    const runCtx: ToolRunContext = { ...context, callId: call.id };
    runCtx.emit({ type: "tool.start", id: call.id, name: call.name, arguments: call.arguments });

    try {
      if (!tool) {
        throw new Error(`Tool "${call.name}" is not registered or not permitted in this scope.`);
      }

      const requiredMode = tool.requiredSandboxMode ?? "read-only";
      assertModePermitted(runCtx.sandbox.mode, requiredMode, tool.name);

      let parsedArgs: unknown;
      try {
        parsedArgs = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      } catch (parseError) {
        throw new Error(
          `Invalid JSON arguments for "${call.name}": ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        );
      }

      const prePayload = this.#host
        ? await this.#host.runWaterfall("tools/pre-execute", {
            call,
            args: parsedArgs,
            tool,
            context: runCtx,
          })
        : { call, args: parsedArgs, tool, context: runCtx };

      const timeoutMs = tool.timeoutMs ?? 30_000;
      const timeoutController = new AbortController();
      const onParentAbort = () => timeoutController.abort(runCtx.signal.reason);
      runCtx.signal.addEventListener("abort", onParentAbort, { once: true });
      const timer = setTimeout(
        () => timeoutController.abort(new Error(`Tool "${call.name}" timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      let rawResult: unknown;
      try {
        rawResult = await tool.execute(prePayload.args, {
          ...runCtx,
          signal: timeoutController.signal,
        });
      } finally {
        clearTimeout(timer);
        runCtx.signal.removeEventListener("abort", onParentAbort);
      }

      const serialized = truncateOutput(
        typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult),
      );
      const summary = tool.summarize?.(rawResult) ?? `${call.name} completed`;
      const durationMs = Date.now() - start;

      const outcome: ToolExecutionOutcome = {
        callId: call.id,
        name: call.name,
        output: serialized,
        summary,
        isError: false,
        durationMs,
      };

      const finalOutcome = this.#host
        ? await this.#host.runWaterfall("tools/post-execute", outcome)
        : outcome;

      runCtx.emit({
        type: "tool.end",
        id: call.id,
        name: call.name,
        summary: finalOutcome.summary,
        error: finalOutcome.isError || undefined,
        durationMs: finalOutcome.durationMs,
      });

      return finalOutcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      const durationMs = Date.now() - start;
      const outcome: ToolExecutionOutcome = {
        callId: call.id,
        name: call.name,
        output: JSON.stringify({ error: message }),
        summary: message,
        isError: true,
        durationMs,
      };
      runCtx.emit({
        type: "tool.end",
        id: call.id,
        name: call.name,
        summary: message,
        error: true,
        durationMs,
      });
      return outcome;
    }
  }

  /**
   * Executes a batch of tool calls while preserving model order in returned outcomes.
   * Consecutive concurrency-safe calls run in parallel; exclusive calls run sequentially as barriers.
   */
  async executeBatch(
    calls: readonly LlmToolCall[],
    context: Omit<ToolRunContext, "callId">,
    restriction?: ToolRestriction,
  ): Promise<ToolExecutionOutcome[]> {
    const results = new Array<ToolExecutionOutcome>(calls.length);
    let i = 0;

    while (i < calls.length) {
      const call = calls[i];
      if (!call) break;
      const tool = this.get(call.name);
      if (tool?.concurrencySafe) {
        const groupIndices: number[] = [];
        while (i < calls.length) {
          const nextCall = calls[i];
          if (!nextCall || !this.get(nextCall.name)?.concurrencySafe) break;
          groupIndices.push(i);
          i += 1;
        }
        await Promise.all(
          groupIndices.map(async (idx) => {
            const targetCall = calls[idx]!;
            results[idx] = await this.executeSingle(targetCall, context, restriction);
          }),
        );
      } else {
        results[i] = await this.executeSingle(call, context, restriction);
        i += 1;
      }
    }

    return results;
  }
}

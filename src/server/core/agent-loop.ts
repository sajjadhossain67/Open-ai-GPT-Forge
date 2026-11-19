import { randomUUID } from "node:crypto";
import type { StreamEvent, TokenUsage } from "../../shared/types.js";
import { CompactionEngine } from "./compaction.js";
import { Logger, rootLogger } from "./logger.js";
import type { PluginHost } from "./plugin-host.js";
import { PromptAssembler } from "./prompt.js";
import type { EventSession } from "./session.js";
import { LlmFailure, type LlmToolCall } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolRestriction } from "../tools/types.js";

export interface AgentLoopDeps {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  prompt: PromptAssembler;
  compaction: CompactionEngine;
  host?: PluginHost;
  logger?: Logger;
  maxSteps?: number;
}

export interface RunTurnOptions {
  session: EventSession;
  userContent: string;
  emit: (event: StreamEvent) => void;
  signal: AbortSignal;
  maxSteps?: number;
  toolRestriction?: ToolRestriction;
}

export interface RunTurnResult {
  turn: number;
  stepsExecuted: number;
  finalText: string;
  finalReasoning: string;
  usage: TokenUsage;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Autonomous Turn & Step Agent Loop inspired by DeepSeek Harness's `core/agent-loop`.
 *
 * Turn lifecycle:
 *   turn/start -> user/message -> [compaction check] ->
 *   repeat step:
 *     step/start -> pre-step hooks -> prompt assembly -> LLM stream (with retry & overflow recovery) ->
 *     assistant/message -> tool/call* -> guarded tool batch -> tool/result* -> step/end
 *   -> turn/end
 */
export class AgentLoop {
  readonly #providers: ProviderRegistry;
  readonly #tools: ToolRegistry;
  readonly #prompt: PromptAssembler;
  readonly #compaction: CompactionEngine;
  readonly #host?: PluginHost;
  readonly #logger: Logger;
  readonly #defaultMaxSteps: number;

  constructor(deps: AgentLoopDeps) {
    this.#providers = deps.providers;
    this.#tools = deps.tools;
    this.#prompt = deps.prompt;
    this.#compaction = deps.compaction;
    this.#host = deps.host;
    this.#logger = deps.logger ?? rootLogger.child("agent-loop");
    this.#defaultMaxSteps = deps.maxSteps ?? 12;
  }

  async runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
    const { session, userContent, emit, signal, toolRestriction } = options;
    const maxSteps = options.maxSteps ?? this.#defaultMaxSteps;
    const turn = session.nextTurnNumber();
    const adapter = this.#providers.require(session.meta.provider);
    const model = session.meta.model || adapter.defaultModel;

    const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0 };
    const assistantMessageId = randomUUID();
    let combinedText = "";
    let combinedReasoning = "";
    let stepsExecuted = 0;

    await session.append({ type: "turn/start", data: { turn } });
    await session.append({
      type: "user/message",
      data: { id: randomUUID(), content: userContent, source: "user" },
    });

    emit({ type: "message.start", messageId: assistantMessageId, provider: adapter.id, model });

    let endReason: "completed" | "aborted" | "error" = "completed";

    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        if (signal.aborted) {
          endReason = "aborted";
          break;
        }

        // Automatic compaction under token pressure before the step starts
        if (this.#compaction.needsCompaction(session)) {
          const compacted = await this.#compaction.compact(session, { adapter, model, signal });
          if (compacted.compacted) {
            emit({
              type: "compaction.done",
              prunedMessages: compacted.prunedMessages,
              summaryLength: compacted.summaryLength,
            });
          }
        }

        await session.append({ type: "step/start", data: { turn, step } });
        emit({ type: "step.start", turn, step });
        stepsExecuted = step;

        if (this.#host) {
          await this.#host.runWaterfall("agent/pre-step", { session, turn, step });
        }

        let stepText = "";
        let stepReasoning = "";
        let stepCalls: LlmToolCall[] = [];
        let stepUsage: TokenUsage | undefined;
        let overflowRetried = false;

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const systemPrompt = await this.#prompt.assemble({
            session,
            baseInstructions: session.meta.instructions,
          });
          const messages = session.deriveLlmMessages();
          const toolSchemas = this.#tools.schemas(toolRestriction);

          stepText = "";
          stepReasoning = "";
          stepCalls = [];
          stepUsage = undefined;

          try {
            for await (const chunk of adapter.stream({
              model,
              systemPrompt,
              messages,
              tools: toolSchemas,
              signal,
            })) {
              if (chunk.type === "reasoning-delta") {
                stepReasoning += chunk.text;
                combinedReasoning += chunk.text;
                emit({ type: "reasoning.delta", delta: chunk.text });
              } else if (chunk.type === "text-delta") {
                stepText += chunk.text;
                combinedText += chunk.text;
                emit({ type: "message.delta", delta: chunk.text });
              } else if (chunk.type === "tool-call") {
                stepCalls.push(chunk.call);
              } else if (chunk.type === "usage") {
                stepUsage = chunk.usage;
              }
            }
            break;
          } catch (error) {
            if (signal.aborted) {
              endReason = "aborted";
              break;
            }
            if (error instanceof LlmFailure && error.code === "CONTEXT_OVERFLOW" && !overflowRetried) {
              overflowRetried = true;
              this.#logger.warn("Context overflow detected; attempting compaction recovery", {
                sessionId: session.id,
                step,
              });
              const compacted = await this.#compaction.compact(session, { adapter, model, force: true, signal });
              if (compacted.compacted) {
                emit({
                  type: "compaction.done",
                  prunedMessages: compacted.prunedMessages,
                  summaryLength: compacted.summaryLength,
                });
                continue;
              }
            }
            if (error instanceof LlmFailure && error.retryable && attempt < 3) {
              const backoffMs = attempt * 600;
              this.#logger.warn("Retryable LLM failure; backing off", {
                provider: adapter.id,
                attempt,
                code: error.code,
                backoffMs,
              });
              await delay(backoffMs, signal);
              continue;
            }
            throw error;
          }
        }

        if (signal.aborted) {
          endReason = "aborted";
          await session.append({ type: "step/end", data: { turn, step, usage: stepUsage } });
          emit({ type: "step.end", turn, step, usage: stepUsage });
          break;
        }

        if (stepUsage) {
          totalUsage.inputTokens += stepUsage.inputTokens;
          totalUsage.outputTokens += stepUsage.outputTokens;
          totalUsage.totalTokens += stepUsage.totalTokens;
          totalUsage.reasoningTokens = (totalUsage.reasoningTokens ?? 0) + (stepUsage.reasoningTokens ?? 0);
        }

        await session.append({
          type: "assistant/message",
          data: {
            id: step === 1 ? assistantMessageId : randomUUID(),
            turn,
            step,
            content: stepText,
            reasoning: stepReasoning || undefined,
            toolCalls: stepCalls.length > 0 ? stepCalls : undefined,
            usage: stepUsage,
            provider: adapter.id,
            model,
          },
        });

        if (stepCalls.length === 0) {
          await session.append({ type: "step/end", data: { turn, step, usage: stepUsage } });
          emit({ type: "step.end", turn, step, usage: stepUsage });
          break;
        }

        for (const call of stepCalls) {
          await session.append({
            type: "tool/call",
            data: { turn, step, callId: call.id, name: call.name, arguments: call.arguments },
          });
        }

        const outcomes = await this.#tools.executeBatch(
          stepCalls,
          {
            signal,
            session,
            sandbox: {
              mode: session.meta.sandboxMode,
              workspaceRoot: session.meta.workspaceRoot,
            },
            emit,
          },
          toolRestriction,
        );

        for (const outcome of outcomes) {
          await session.append({
            type: "tool/result",
            data: {
              turn,
              step,
              callId: outcome.callId,
              name: outcome.name,
              output: outcome.output,
              summary: outcome.summary,
              isError: outcome.isError,
              durationMs: outcome.durationMs,
            },
          });
        }

        await session.append({ type: "step/end", data: { turn, step, usage: stepUsage } });
        emit({ type: "step.end", turn, step, usage: stepUsage });

        if (step === maxSteps) {
          const notice = `\n\n[Reached maximum autonomous step limit (${maxSteps}). You can send a follow-up to continue.]`;
          combinedText += notice;
          emit({ type: "message.delta", delta: notice });
          await session.append({
            type: "assistant/message",
            data: {
              id: randomUUID(),
              turn,
              step,
              content: notice.trim(),
              provider: adapter.id,
              model,
            },
          });
        }
      }
    } catch (error) {
      endReason = signal.aborted ? "aborted" : "error";
      throw error;
    } finally {
      await session.append({ type: "turn/end", data: { turn, reason: endReason } });
      if (this.#host) {
        await this.#host.emitSerial("agent/turn-end", { session, turn, reason: endReason });
      }
    }

    return {
      turn,
      stepsExecuted,
      finalText: combinedText,
      finalReasoning: combinedReasoning,
      usage: totalUsage,
    };
  }
}

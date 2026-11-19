import type { LlmAdapter, LlmMessage } from "../providers/types.js";
import type { EventSession } from "./session.js";

export interface CompactionConfig {
  /** Estimated token count above which automatic compaction triggers. */
  maxEstimatedTokens: number;
  /** Minimum number of recent events to retain uncompacted. */
  retainRecentEvents: number;
}

export interface CompactionOutcome {
  compacted: boolean;
  prunedMessages: number;
  summaryLength: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

const DEFAULT_CONFIG: CompactionConfig = {
  maxEstimatedTokens: 28_000,
  retainRecentEvents: 8,
};

/**
 * Fast, deterministic heuristic token estimator (~4 chars per token + per-message overhead).
 */
export function estimateTokens(messages: readonly LlmMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += 16;
    chars += msg.content.length;
    if (msg.role === "assistant") {
      if (msg.reasoning) chars += msg.reasoning.length;
      if (msg.toolCalls) {
        for (const call of msg.toolCalls) {
          chars += call.name.length + call.arguments.length + 12;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Deterministic model-free extractive summary fallback when an LLM summarizer
 * is unavailable or fails. Preserves key user goals, tool outcomes, and decisions.
 */
function buildDeterministicSummary(messages: readonly LlmMessage[]): string {
  const lines: string[] = ["Compacted earlier session history:"];
  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push(`- User: ${msg.content.replace(/\s+/g, " ").trim().slice(0, 240)}`);
    } else if (msg.role === "assistant" && msg.content.trim()) {
      lines.push(`- Assistant: ${msg.content.replace(/\s+/g, " ").trim().slice(0, 240)}`);
    } else if (msg.role === "tool") {
      lines.push(`- Tool (${msg.toolName}): ${msg.content.replace(/\s+/g, " ").trim().slice(0, 140)}`);
    }
  }
  return lines.slice(0, 40).join("\n");
}

/**
 * Context Compaction Engine inspired by DeepSeek Harness's `ctx.compaction`.
 * Appends a durable `compaction/checkpoint` event that shadows older messages while
 * preserving tool-call/result pairing boundaries in the retained tail.
 */
export class CompactionEngine {
  readonly #config: CompactionConfig;

  constructor(config: Partial<CompactionConfig> = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  needsCompaction(session: EventSession): boolean {
    const messages = session.deriveLlmMessages();
    return estimateTokens(messages) > this.#config.maxEstimatedTokens;
  }

  async compact(
    session: EventSession,
    options: { adapter?: LlmAdapter; model?: string; force?: boolean; signal?: AbortSignal } = {},
  ): Promise<CompactionOutcome> {
    const messagesBefore = session.deriveLlmMessages();
    const tokensBefore = estimateTokens(messagesBefore);

    if (!options.force && tokensBefore <= this.#config.maxEstimatedTokens) {
      return {
        compacted: false,
        prunedMessages: 0,
        summaryLength: 0,
        estimatedTokensBefore: tokensBefore,
        estimatedTokensAfter: tokensBefore,
      };
    }

    const events = session.events;
    // Find a safe cut point that leaves at least `retainRecentEvents` and does NOT split
    // an assistant tool-call message from its subsequent tool/result events.
    let cutIndex = events.length - this.#config.retainRecentEvents;
    if (cutIndex <= 1) {
      return {
        compacted: false,
        prunedMessages: 0,
        summaryLength: 0,
        estimatedTokensBefore: tokensBefore,
        estimatedTokensAfter: tokensBefore,
      };
    }

    // Move cutIndex backwards until we land on a clean boundary (not right before a tool/result)
    while (cutIndex > 1 && events[cutIndex]?.type === "tool/result") {
      cutIndex -= 1;
    }
    const cutEvent = events[cutIndex - 1];
    if (!cutEvent) {
      return {
        compacted: false,
        prunedMessages: 0,
        summaryLength: 0,
        estimatedTokensBefore: tokensBefore,
        estimatedTokensAfter: tokensBefore,
      };
    }

    const toSummarize: LlmMessage[] = [];
    for (let i = 0; i < cutIndex; i += 1) {
      const ev = events[i];
      if (!ev) continue;
      if (ev.type === "user/message") toSummarize.push({ role: "user", content: ev.data.content });
      else if (ev.type === "assistant/message") toSummarize.push({ role: "assistant", content: ev.data.content });
      else if (ev.type === "tool/result") {
        toSummarize.push({
          role: "tool",
          toolCallId: ev.data.callId,
          toolName: ev.data.name,
          content: ev.data.output.slice(0, 300),
          isError: ev.data.isError,
        });
      }
    }

    if (toSummarize.length === 0) {
      return {
        compacted: false,
        prunedMessages: 0,
        summaryLength: 0,
        estimatedTokensBefore: tokensBefore,
        estimatedTokensAfter: tokensBefore,
      };
    }

    let summary = "";
    if (options.adapter?.isConfigured()) {
      try {
        const controller = new AbortController();
        const signal = options.signal ?? controller.signal;
        const transcript = toSummarize
          .map((m) => `[${m.role}${m.role === "tool" ? `:${m.toolName}` : ""}] ${m.content.slice(0, 600)}`)
          .join("\n");
        for await (const chunk of options.adapter.stream({
          model: options.model ?? options.adapter.defaultModel,
          systemPrompt:
            "Summarize the following conversation transcript concisely for continuation. Preserve user goals, key technical decisions, file paths, tool outputs, and open questions.",
          messages: [{ role: "user", content: transcript }],
          tools: [],
          maxTokens: 800,
          signal,
        })) {
          if (chunk.type === "text-delta") summary += chunk.text;
        }
      } catch {
        summary = "";
      }
    }

    if (!summary.trim()) {
      summary = buildDeterministicSummary(toSummarize);
    }

    await session.append({
      type: "compaction/checkpoint",
      data: {
        summary: summary.trim(),
        shadowedThroughSeq: cutEvent.seq,
        prunedCount: toSummarize.length,
      },
    });

    const tokensAfter = estimateTokens(session.deriveLlmMessages());
    return {
      compacted: true,
      prunedMessages: toSummarize.length,
      summaryLength: summary.trim().length,
      estimatedTokensBefore: tokensBefore,
      estimatedTokensAfter: tokensAfter,
    };
  }
}

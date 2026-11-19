import type { SandboxMode, StreamEvent, ToolInfo } from "../../shared/types.js";
import type { EventSession } from "../core/session.js";
import type { SandboxExecutionPolicy } from "../sandbox/policy.js";

export interface ToolRunContext {
  readonly signal: AbortSignal;
  readonly session: EventSession;
  readonly sandbox: SandboxExecutionPolicy;
  readonly callId: string;
  readonly emit: (event: StreamEvent) => void;
}

export interface HarnessTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly category: string;
  readonly concurrencySafe?: boolean;
  readonly timeoutMs?: number;
  readonly requiredSandboxMode?: SandboxMode;
  readonly source?: "builtin" | "mcp" | "plugin";
  execute(input: unknown, context: ToolRunContext): Promise<unknown>;
  summarize?(result: unknown): string;
}

export interface ToolRestriction {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export interface ToolExecutionOutcome {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
  readonly summary: string;
  readonly isError: boolean;
  readonly durationMs: number;
}

export function toToolInfo(tool: HarnessTool): ToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    category: tool.category,
    concurrencySafe: Boolean(tool.concurrencySafe),
    requiredSandboxMode: tool.requiredSandboxMode ?? "read-only",
    source: tool.source ?? "builtin",
  };
}

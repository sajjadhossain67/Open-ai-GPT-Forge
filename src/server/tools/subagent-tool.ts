import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentLoop } from "../core/agent-loop.js";
import type { SessionStore } from "../core/session.js";
import type { HarnessTool } from "./types.js";

const delegateSchema = z.object({
  task: z.string().min(1).max(10_000),
  role: z.string().min(1).max(100).default("Research & Implementation Subagent"),
  readOnly: z.boolean().default(true),
  maxSteps: z.number().int().min(1).max(8).default(6),
});

/**
 * Autonomous Subagent Delegation tool inspired by DeepSeek Harness's `ctx.subagents`.
 * Spawns an isolated child session with scoped tool restrictions (preventing recursive delegation)
 * and streams lifecycle events back to the parent session.
 */
export function createSubagentTool(deps: {
  getLoop: () => AgentLoop;
  sessions: SessionStore;
}): HarnessTool {
  return {
    name: "delegate_task",
    category: "orchestration",
    concurrencySafe: true,
    requiredSandboxMode: "read-only",
    timeoutMs: 120_000,
    description:
      "Delegate a focused subtask to an autonomous child agent with its own isolated context. Ideal for codebase exploration, parallel analysis, or bounded sub-problems.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Clear, self-contained task description for the subagent." },
        role: { type: "string", description: "Role title for the subagent (e.g., 'Codebase Analyst')." },
        readOnly: {
          type: "boolean",
          description: "If true (default), confines the subagent to read-only sandbox mode.",
        },
        maxSteps: { type: "integer", description: "Maximum tool-calling steps for the subagent (1-8, default 6)." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const args = delegateSchema.parse(input);
      const subagentId = `sub_${randomUUID().slice(0, 8)}`;
      const childMode = args.readOnly ? "read-only" : ctx.sandbox.mode;

      ctx.emit({
        type: "subagent.event",
        subagentId,
        task: args.task.slice(0, 140),
        status: "started",
      });

      const childSession = await deps.sessions.create({
        id: subagentId,
        title: `[Subagent] ${args.role}`,
        provider: ctx.session.meta.provider,
        model: ctx.session.meta.model,
        instructions: `You are a focused subagent (${args.role}). Complete the delegated task accurately and return a concise, structured report.`,
        sandboxMode: childMode,
        workspaceRoot: ctx.sandbox.workspaceRoot,
      });

      try {
        const result = await deps.getLoop().runTurn({
          session: childSession,
          userContent: args.task,
          emit: () => {
            // Child stream events stay isolated; parent receives summary lifecycle events
          },
          signal: ctx.signal,
          maxSteps: args.maxSteps,
          toolRestriction: { deny: ["delegate_task"] },
        });

        ctx.emit({
          type: "subagent.event",
          subagentId,
          task: args.task.slice(0, 140),
          status: "completed",
          summary: result.finalText.slice(0, 200),
        });

        return {
          subagentId,
          role: args.role,
          stepsExecuted: result.stepsExecuted,
          report: result.finalText || "(Subagent finished without text output)",
          usage: result.usage,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.emit({
          type: "subagent.event",
          subagentId,
          task: args.task.slice(0, 140),
          status: "error",
          summary: message,
        });
        throw error;
      } finally {
        await deps.sessions.delete(subagentId).catch(() => undefined);
      }
    },
    summarize(result) {
      const r = result as { role: string; stepsExecuted: number };
      return `Subagent "${r.role}" completed in ${r.stepsExecuted} step(s)`;
    },
  };
}

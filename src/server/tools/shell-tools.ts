import { z } from "zod";
import { runSandboxedCode, runSandboxedShellCommand } from "../sandbox/executor.js";
import type { HarnessTool } from "./types.js";

const runCommandSchema = z.object({
  command: z.string().min(1).max(4000),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(500).max(120_000).optional(),
});

const runCodeSchema = z.object({
  language: z.enum(["javascript", "python"]),
  code: z.string().min(1).max(50_000),
  timeoutMs: z.number().int().min(500).max(60_000).optional(),
});

export const runCommandTool: HarnessTool = {
  name: "run_command",
  category: "execution",
  concurrencySafe: false,
  requiredSandboxMode: "workspace-write",
  timeoutMs: 120_000,
  description:
    "Execute a shell command inside the workspace with sanitized environment variables, timeout enforcement, and sandbox guardrails.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      cwd: { type: "string", description: "Optional working directory inside the workspace." },
      timeoutMs: { type: "integer", description: "Execution timeout in milliseconds (default 15000)." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const args = runCommandSchema.parse(input);
    return runSandboxedShellCommand({
      command: args.command,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      policy: ctx.sandbox,
      signal: ctx.signal,
    });
  },
  summarize(result) {
    const r = result as { exitCode: number | null; timedOut: boolean; durationMs: number };
    if (r.timedOut) return `Command timed out after ${r.durationMs}ms`;
    return `Command exited with code ${r.exitCode ?? "null"} (${r.durationMs}ms)`;
  },
};

export const runCodeTool: HarnessTool = {
  name: "run_code",
  category: "execution",
  concurrencySafe: false,
  requiredSandboxMode: "workspace-write",
  timeoutMs: 60_000,
  description: "Execute an isolated JavaScript (Node.js) or Python snippet with sanitized environment and timeout.",
  parameters: {
    type: "object",
    properties: {
      language: { type: "string", enum: ["javascript", "python"], description: "Runtime language." },
      code: { type: "string", description: "Source code to execute." },
      timeoutMs: { type: "integer", description: "Timeout in milliseconds (default 10000)." },
    },
    required: ["language", "code"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const args = runCodeSchema.parse(input);
    return runSandboxedCode({
      language: args.language,
      code: args.code,
      timeoutMs: args.timeoutMs,
      policy: ctx.sandbox,
      signal: ctx.signal,
    });
  },
  summarize(result) {
    const r = result as { exitCode: number | null; timedOut: boolean; durationMs: number };
    if (r.timedOut) return `Code timed out (${r.durationMs}ms)`;
    return `Code exited with code ${r.exitCode ?? "null"} (${r.durationMs}ms)`;
  },
};

export const shellTools: HarnessTool[] = [runCommandTool, runCodeTool];

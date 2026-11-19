import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertModePermitted, resolveConfinedPath, SandboxViolationError, type SandboxExecutionPolicy } from "./policy.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 32_768;

const SECRET_ENV_PATTERN = /(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIALS)/i;

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\s+\/(?:\s|$)/i, reason: "destructive root deletion" },
  { pattern: /\bformat\s+[a-z]:/i, reason: "disk format command" },
  { pattern: /\bmkfs\b/i, reason: "filesystem format command" },
  { pattern: /\bdd\s+if=/i, reason: "raw disk write command" },
  { pattern: /\bshutdown\b|\breboot\b/i, reason: "host power command" },
];

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

function buildSanitizedEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_ENV_PATTERN.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function checkCommandSafety(command: string, policy: SandboxExecutionPolicy): void {
  if (policy.mode === "danger-full-access") return;
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(command)) {
      throw new SandboxViolationError(`Command blocked by sandbox guardrail: ${rule.reason}`, "COMMAND_BLOCKED");
    }
  }
}

export async function runSandboxedProcess(options: {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 500), MAX_TIMEOUT_MS);
  const start = Date.now();

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: buildSanitizedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (totalBytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const remaining = MAX_OUTPUT_BYTES - totalBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (chunk.length > remaining) truncated = true;
      totalBytes += slice.length;
      const text = slice.toString("utf8");
      if (target === "stdout") stdout += text;
      else stderr += text;
    };

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));

    const killChild = () => {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already exited
          }
        }, 1000).unref();
      } catch {
        // already exited
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);

    const onAbort = () => {
      killChild();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        truncated,
        durationMs: Date.now() - start,
      });
    });
  });
}

export async function runSandboxedShellCommand(options: {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  policy: SandboxExecutionPolicy;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  assertModePermitted(options.policy.mode, "workspace-write", "run_command");
  checkCommandSafety(options.command, options.policy);

  const resolvedCwd = options.cwd
    ? await resolveConfinedPath(options.policy, options.cwd, "read")
    : options.policy.workspaceRoot;

  const isWindows = process.platform === "win32";
  const shellFile = isWindows ? "powershell.exe" : "/bin/sh";
  const shellArgs = isWindows
    ? ["-NoProfile", "-NonInteractive", "-Command", options.command]
    : ["-c", options.command];

  return runSandboxedProcess({
    file: shellFile,
    args: shellArgs,
    cwd: resolvedCwd,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export async function runSandboxedCode(options: {
  language: "javascript" | "python";
  code: string;
  timeoutMs?: number;
  policy: SandboxExecutionPolicy;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  assertModePermitted(options.policy.mode, "workspace-write", "run_code");

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "forge-exec-"));
  const ext = options.language === "javascript" ? "mjs" : "py";
  const scriptPath = path.join(tempDir, `snippet.${ext}`);
  try {
    await writeFile(scriptPath, options.code, "utf8");
    const file = options.language === "javascript" ? process.execPath : "python";
    return await runSandboxedProcess({
      file,
      args: [scriptPath],
      cwd: options.policy.workspaceRoot,
      timeoutMs: options.timeoutMs ?? 10_000,
      signal: options.signal,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

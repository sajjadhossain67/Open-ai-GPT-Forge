import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSandboxedCode, runSandboxedShellCommand } from "./executor.js";
import { resolveConfinedPath, SandboxViolationError, type SandboxExecutionPolicy } from "./policy.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-sandbox-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Sandbox security boundaries", () => {
  it("blocks path traversal outside workspace root", async () => {
    const workspace = await makeTempDir();
    const policy: SandboxExecutionPolicy = { mode: "workspace-write", workspaceRoot: workspace };

    await expect(resolveConfinedPath(policy, "../outside-secret.txt", "read")).rejects.toBeInstanceOf(
      SandboxViolationError,
    );
    await expect(resolveConfinedPath(policy, path.resolve(workspace, "..", "escape.txt"), "write")).rejects.toThrow(
      /escapes/i,
    );
  });

  it("blocks writes and command execution in read-only mode", async () => {
    const workspace = await makeTempDir();
    const policy: SandboxExecutionPolicy = { mode: "read-only", workspaceRoot: workspace };

    await writeFile(path.join(workspace, "note.txt"), "hello", "utf8");
    const allowedRead = await resolveConfinedPath(policy, "note.txt", "read");
    expect(allowedRead.endsWith("note.txt")).toBe(true);

    await expect(resolveConfinedPath(policy, "new.txt", "write")).rejects.toBeInstanceOf(SandboxViolationError);
    await expect(runSandboxedShellCommand({ command: "echo hi", policy })).rejects.toBeInstanceOf(SandboxViolationError);
    await expect(runSandboxedCode({ language: "javascript", code: "console.log(1)", policy })).rejects.toBeInstanceOf(
      SandboxViolationError,
    );
  });

  it("blocks destructive shell commands under workspace-write", async () => {
    const workspace = await makeTempDir();
    const policy: SandboxExecutionPolicy = { mode: "workspace-write", workspaceRoot: workspace };

    await expect(runSandboxedShellCommand({ command: "rm -rf /", policy })).rejects.toThrow(/blocked by sandbox/i);
  });

  it("strips secret environment variables and enforces timeouts in runSandboxedCode", async () => {
    const workspace = await makeTempDir();
    const policy: SandboxExecutionPolicy = { mode: "workspace-write", workspaceRoot: workspace };

    process.env.TEST_FORGE_SECRET_API_KEY = "super-secret-value";
    try {
      const res = await runSandboxedCode({
        language: "javascript",
        code: "console.log(JSON.stringify({ secret: process.env.TEST_FORGE_SECRET_API_KEY ?? null }))",
        policy,
      });
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout.trim())).toEqual({ secret: null });
    } finally {
      delete process.env.TEST_FORGE_SECRET_API_KEY;
    }

    const timedOut = await runSandboxedCode({
      language: "javascript",
      code: "setTimeout(() => {}, 10000)",
      timeoutMs: 500,
      policy,
    });
    expect(timedOut.timedOut).toBe(true);
  });
});

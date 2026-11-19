import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runSandboxedProcess } from "../sandbox/executor.js";
import type { HarnessTool } from "./types.js";

export const repoOverviewTool: HarnessTool = {
  name: "repo_overview",
  category: "repository",
  concurrencySafe: true,
  requiredSandboxMode: "read-only",
  description: "Summarize the workspace repository structure, package metadata, and current Git branch/status.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(_input, ctx) {
    const root = ctx.sandbox.workspaceRoot;
    const topLevel = (await readdir(root, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith(".") || e.name === ".env.example")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();

    let packageSummary: Record<string, unknown> | undefined;
    try {
      const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
        scripts?: Record<string, string>;
      };
      packageSummary = { name: pkg.name, version: pkg.version, scripts: Object.keys(pkg.scripts ?? {}) };
    } catch {
      packageSummary = undefined;
    }

    const gitBranch = await runSandboxedProcess({
      file: "git",
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: root,
      timeoutMs: 5000,
      signal: ctx.signal,
    }).catch(() => null);

    const gitStatus = await runSandboxedProcess({
      file: "git",
      args: ["status", "--short"],
      cwd: root,
      timeoutMs: 5000,
      signal: ctx.signal,
    }).catch(() => null);

    return {
      workspaceRoot: root,
      topLevel,
      package: packageSummary,
      git: gitBranch?.exitCode === 0
        ? {
            branch: gitBranch.stdout.trim(),
            dirtyFiles: gitStatus?.stdout
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, 50) ?? [],
          }
        : null,
    };
  },
  summarize(result) {
    const r = result as { topLevel: string[]; git: { branch: string } | null };
    return `Inspected repo (${r.topLevel.length} top-level entries${r.git ? `, branch ${r.git.branch}` : ""})`;
  },
};

export const gitDiffTool: HarnessTool = {
  name: "git_diff",
  category: "repository",
  concurrencySafe: true,
  requiredSandboxMode: "read-only",
  description: "Read the current git diff (working tree or staged changes) in the workspace.",
  parameters: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "If true, show staged changes (--cached)." },
      path: { type: "string", description: "Optional path filter." },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const args = z.object({ staged: z.boolean().optional(), path: z.string().optional() }).parse(input ?? {});
    const gitArgs = ["diff", ...(args.staged ? ["--cached"] : []), ...(args.path ? ["--", args.path] : [])];
    const res = await runSandboxedProcess({
      file: "git",
      args: gitArgs,
      cwd: ctx.sandbox.workspaceRoot,
      timeoutMs: 10_000,
      signal: ctx.signal,
    });
    return { exitCode: res.exitCode, diff: res.stdout || "(no changes)", stderr: res.stderr };
  },
  summarize() {
    return "Read git diff";
  },
};

export const repoTools: HarnessTool[] = [repoOverviewTool, gitDiffTool];

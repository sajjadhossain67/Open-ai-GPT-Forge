import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveConfinedPath } from "../sandbox/policy.js";
import type { HarnessTool } from "./types.js";

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "dist-server", ".forge-data"]);

const readFileSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const editFileSchema = z.object({
  path: z.string().min(1),
  target: z.string().min(1),
  replacement: z.string(),
});

const listDirSchema = z.object({
  path: z.string().default("."),
  maxDepth: z.number().int().min(1).max(5).default(2),
});

const searchFilesSchema = z.object({
  query: z.string().min(1).max(200),
  path: z.string().default("."),
  maxResults: z.number().int().min(1).max(100).default(30),
});

export const readFileTool: HarnessTool = {
  name: "read_file",
  category: "filesystem",
  concurrencySafe: true,
  requiredSandboxMode: "read-only",
  description: "Read the contents of a text file inside the workspace, optionally sliced by line range.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative or workspace-contained path to the file." },
      startLine: { type: "integer", description: "1-based inclusive start line." },
      endLine: { type: "integer", description: "1-based inclusive end line." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const args = readFileSchema.parse(input);
    const resolved = await resolveConfinedPath(ctx.sandbox, args.path, "read");
    const raw = await readFile(resolved, "utf8");
    const lines = raw.split(/\r?\n/);
    const start = Math.max(1, args.startLine ?? 1);
    const end = Math.min(lines.length, args.endLine ?? Math.min(lines.length, start + 399));
    const slice = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`);
    return {
      path: path.relative(ctx.sandbox.workspaceRoot, resolved) || path.basename(resolved),
      totalLines: lines.length,
      startLine: start,
      endLine: end,
      content: slice.join("\n"),
    };
  },
  summarize(result) {
    const r = result as { path: string; startLine: number; endLine: number };
    return `Read ${r.path} (L${r.startLine}-${r.endLine})`;
  },
};

export const writeFileTool: HarnessTool = {
  name: "write_file",
  category: "filesystem",
  concurrencySafe: false,
  requiredSandboxMode: "workspace-write",
  description: "Create or overwrite a file inside the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative or workspace-contained path to write." },
      content: { type: "string", description: "Full UTF-8 file contents." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const args = writeFileSchema.parse(input);
    const resolved = await resolveConfinedPath(ctx.sandbox, args.path, "write");
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, args.content, "utf8");
    return {
      path: path.relative(ctx.sandbox.workspaceRoot, resolved) || path.basename(resolved),
      bytesWritten: Buffer.byteLength(args.content, "utf8"),
    };
  },
  summarize(result) {
    const r = result as { path: string; bytesWritten: number };
    return `Wrote ${r.path} (${r.bytesWritten} bytes)`;
  },
};

export const editFileTool: HarnessTool = {
  name: "edit_file",
  category: "filesystem",
  concurrencySafe: false,
  requiredSandboxMode: "workspace-write",
  description: "Replace an exact target string inside a workspace file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit." },
      target: { type: "string", description: "Exact existing substring to replace." },
      replacement: { type: "string", description: "Replacement text." },
    },
    required: ["path", "target", "replacement"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const args = editFileSchema.parse(input);
    const resolved = await resolveConfinedPath(ctx.sandbox, args.path, "write");
    const existing = await readFile(resolved, "utf8");
    if (!existing.includes(args.target)) {
      throw new Error(`Target text not found in ${args.path}`);
    }
    const updated = existing.replace(args.target, args.replacement);
    await writeFile(resolved, updated, "utf8");
    return {
      path: path.relative(ctx.sandbox.workspaceRoot, resolved) || path.basename(resolved),
      replaced: true,
    };
  },
  summarize(result) {
    const r = result as { path: string };
    return `Edited ${r.path}`;
  },
};

export const listDirectoryTool: HarnessTool = {
  name: "list_directory",
  category: "filesystem",
  concurrencySafe: true,
  requiredSandboxMode: "read-only",
  description: "List files and directories within the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path relative to workspace root (default '.')." },
      maxDepth: { type: "integer", description: "Maximum recursion depth (1-5, default 2)." },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const args = listDirSchema.parse(input ?? {});
    const root = await resolveConfinedPath(ctx.sandbox, args.path, "read");
    const entries: Array<{ path: string; type: "file" | "dir"; size?: number }> = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > args.maxDepth || entries.length >= 250) return;
      const items = await readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (IGNORE_DIRS.has(item.name)) continue;
        if (entries.length >= 250) break;
        const full = path.join(dir, item.name);
        const rel = path.relative(ctx.sandbox.workspaceRoot, full);
        if (item.isDirectory()) {
          entries.push({ path: rel, type: "dir" });
          if (depth < args.maxDepth) await walk(full, depth + 1);
        } else if (item.isFile()) {
          const info = await stat(full).catch(() => null);
          entries.push({ path: rel, type: "file", size: info?.size });
        }
      }
    };

    await walk(root, 1);
    return { root: path.relative(ctx.sandbox.workspaceRoot, root) || ".", count: entries.length, entries };
  },
  summarize(result) {
    const r = result as { root: string; count: number };
    return `Listed ${r.count} entries in ${r.root}`;
  },
};

export const searchFilesTool: HarnessTool = {
  name: "search_files",
  category: "filesystem",
  concurrencySafe: true,
  requiredSandboxMode: "read-only",
  description: "Search for a case-insensitive text query across workspace files.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Substring to search for." },
      path: { type: "string", description: "Subdirectory to search (default '.')." },
      maxResults: { type: "integer", description: "Maximum number of line matches (default 30)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const args = searchFilesSchema.parse(input);
    const root = await resolveConfinedPath(ctx.sandbox, args.path, "read");
    const needle = args.query.toLowerCase();
    const matches: Array<{ file: string; line: number; text: string }> = [];

    const walk = async (dir: string): Promise<void> => {
      if (matches.length >= args.maxResults || ctx.signal.aborted) return;
      const items = await readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (matches.length >= args.maxResults || ctx.signal.aborted) break;
        if (IGNORE_DIRS.has(item.name)) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          await walk(full);
        } else if (item.isFile()) {
          const info = await stat(full).catch(() => null);
          if (!info || info.size > 512_000) continue;
          const text = await readFile(full, "utf8").catch(() => null);
          if (!text || text.includes("\0")) continue;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            if (lines[i]!.toLowerCase().includes(needle)) {
              matches.push({
                file: path.relative(ctx.sandbox.workspaceRoot, full),
                line: i + 1,
                text: lines[i]!.trim().slice(0, 200),
              });
              if (matches.length >= args.maxResults) break;
            }
          }
        }
      }
    };

    await walk(root);
    return { query: args.query, count: matches.length, matches };
  },
  summarize(result) {
    const r = result as { query: string; count: number };
    return `Found ${r.count} matches for "${r.query}"`;
  },
};

export const filesystemTools: HarnessTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  searchFilesTool,
];

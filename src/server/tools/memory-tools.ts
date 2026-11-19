import { z } from "zod";
import type { MemoryStore } from "../memory/store.js";
import type { HarnessTool } from "./types.js";

export function createMemoryTools(store: MemoryStore): HarnessTool[] {
  const saveTool: HarnessTool = {
    name: "memory_save",
    category: "memory",
    concurrencySafe: false,
    requiredSandboxMode: "read-only",
    description: "Save or update a persistent fact, user preference, or architectural decision in long-term memory.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Unique short identifier for this memory entry." },
        content: { type: "string", description: "The information to remember." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization.",
        },
      },
      required: ["key", "content"],
      additionalProperties: false,
    },
    async execute(input) {
      const args = z
        .object({
          key: z.string().min(1).max(120),
          content: z.string().min(1).max(10_000),
          tags: z.array(z.string().max(40)).max(10).optional(),
        })
        .parse(input);
      const entry = await store.upsert(args.key, args.content, args.tags ?? []);
      return { saved: true, entry };
    },
    summarize(result) {
      const r = result as { entry: { key: string } };
      return `Saved memory "${r.entry.key}"`;
    },
  };

  const searchTool: HarnessTool = {
    name: "memory_search",
    category: "memory",
    concurrencySafe: true,
    requiredSandboxMode: "read-only",
    description: "Search persistent long-term memory entries by keyword and/or tag.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword query (empty string returns recent memories)." },
        tag: { type: "string", description: "Optional tag filter." },
        limit: { type: "integer", description: "Max entries to return (default 10)." },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const args = z
        .object({
          query: z.string().default(""),
          tag: z.string().optional(),
          limit: z.number().int().min(1).max(50).default(10),
        })
        .parse(input ?? {});
      const entries = await store.search(args.query, args.tag, args.limit);
      return { count: entries.length, entries };
    },
    summarize(result) {
      const r = result as { count: number };
      return `Found ${r.count} memory entries`;
    },
  };

  const deleteTool: HarnessTool = {
    name: "memory_delete",
    category: "memory",
    concurrencySafe: false,
    requiredSandboxMode: "read-only",
    description: "Delete a persistent memory entry by its key or id.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Memory key or ID to delete." },
      },
      required: ["key"],
      additionalProperties: false,
    },
    async execute(input) {
      const { key } = z.object({ key: z.string().min(1) }).parse(input);
      const deleted = await store.delete(key);
      return { key, deleted };
    },
    summarize(result) {
      const r = result as { key: string; deleted: boolean };
      return r.deleted ? `Deleted memory "${r.key}"` : `Memory "${r.key}" not found`;
    },
  };

  return [saveTool, searchTool, deleteTool];
}

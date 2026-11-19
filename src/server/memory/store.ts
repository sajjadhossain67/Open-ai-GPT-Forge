import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryEntry } from "../../shared/types.js";

interface MemoryStoreData {
  version: 1;
  entries: MemoryEntry[];
}

/**
 * Persistent cross-session memory store using atomic file replacement.
 * Allows agents and users to store, search, tag, and delete durable facts across sessions.
 */
export class MemoryStore {
  readonly #filePath: string;
  #writeQueue = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "memory.json");
  }

  async #read(): Promise<MemoryStoreData> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as MemoryStoreData;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error("Unsupported memory store format");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, entries: [] };
      }
      throw error;
    }
  }

  async #write(data: MemoryStoreData): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temp = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.#filePath);
  }

  #mutate<T>(fn: (data: MemoryStoreData) => T | Promise<T>): Promise<T> {
    const pending = this.#writeQueue.then(async () => {
      const data = await this.#read();
      const result = await fn(data);
      await this.#write(data);
      return result;
    });
    this.#writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async list(): Promise<MemoryEntry[]> {
    await this.#writeQueue;
    return (await this.#read()).entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async upsert(key: string, content: string, tags: string[] = []): Promise<MemoryEntry> {
    const cleanKey = key.trim();
    if (!cleanKey) throw new Error("Memory key must not be empty");
    const cleanTags = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

    return this.#mutate((data) => {
      const now = new Date().toISOString();
      const existing = data.entries.find((e) => e.key.toLowerCase() === cleanKey.toLowerCase());
      if (existing) {
        existing.key = cleanKey;
        existing.content = content;
        existing.tags = cleanTags;
        existing.updatedAt = now;
        return { ...existing };
      }
      const entry: MemoryEntry = {
        id: randomUUID(),
        key: cleanKey,
        content,
        tags: cleanTags,
        createdAt: now,
        updatedAt: now,
      };
      data.entries.push(entry);
      return { ...entry };
    });
  }

  async search(query: string, tag?: string, limit = 10): Promise<MemoryEntry[]> {
    const entries = await this.list();
    const q = query.trim().toLowerCase();
    const tagFilter = tag?.trim().toLowerCase();

    const scored = entries
      .filter((entry) => !tagFilter || entry.tags.includes(tagFilter))
      .map((entry) => {
        if (!q) return { entry, score: 1 };
        const keyHit = entry.key.toLowerCase().includes(q) ? 3 : 0;
        const tagHit = entry.tags.some((t) => t.includes(q)) ? 2 : 0;
        const terms = q.split(/\s+/).filter(Boolean);
        const bodyLower = entry.content.toLowerCase();
        const termHits = terms.reduce((acc, term) => acc + (bodyLower.includes(term) ? 1 : 0), 0);
        return { entry, score: keyHit + tagHit + termHits };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt));

    return scored.slice(0, limit).map((item) => item.entry);
  }

  async delete(idOrKey: string): Promise<boolean> {
    const needle = idOrKey.trim().toLowerCase();
    return this.#mutate((data) => {
      const before = data.entries.length;
      data.entries = data.entries.filter(
        (entry) => entry.id.toLowerCase() !== needle && entry.key.toLowerCase() !== needle,
      );
      return data.entries.length < before;
    });
  }
}

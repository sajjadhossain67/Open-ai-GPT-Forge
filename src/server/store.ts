import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage, Conversation, ConversationSummary } from "../shared/types.js";

interface StoreData { version: 1; conversations: Conversation[] }

export class ConversationStore {
  readonly #file: string;
  #writeQueue = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#file = path.join(dataDirectory, "conversations.json");
  }

  async #read(): Promise<StoreData> {
    try {
      const data = JSON.parse(await readFile(this.#file, "utf8")) as StoreData;
      if (data.version !== 1 || !Array.isArray(data.conversations)) throw new Error("Unsupported conversation store format");
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, conversations: [] };
      throw error;
    }
  }

  async #write(data: StoreData): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.#file);
  }

  #mutate<T>(operation: (data: StoreData) => T | Promise<T>): Promise<T> {
    const pending = this.#writeQueue.then(async () => {
      const data = await this.#read();
      const result = await operation(data);
      await this.#write(data);
      return result;
    });
    this.#writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async list(): Promise<ConversationSummary[]> {
    await this.#writeQueue;
    return (await this.#read()).conversations
      .map(({ messages, ...conversation }) => ({
        ...conversation,
        messageCount: messages.length,
        preview: messages.at(-1)?.content.slice(0, 100) ?? "New conversation",
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Conversation | undefined> {
    await this.#writeQueue;
    return (await this.#read()).conversations.find((item) => item.id === id);
  }

  create(model: string, instructions: string): Promise<Conversation> {
    return this.#mutate((data) => {
      const now = new Date().toISOString();
      const conversation: Conversation = { id: randomUUID(), title: "New conversation", model, instructions, createdAt: now, updatedAt: now, messages: [] };
      data.conversations.push(conversation);
      return conversation;
    });
  }

  addMessage(id: string, message: ChatMessage): Promise<Conversation> {
    return this.#mutate((data) => {
      const conversation = data.conversations.find((item) => item.id === id);
      if (!conversation) throw new Error("Conversation not found");
      conversation.messages.push(message);
      conversation.updatedAt = message.createdAt;
      if (message.role === "user" && conversation.title === "New conversation") {
        conversation.title = message.content.replace(/\s+/g, " ").trim().slice(0, 48) || "New conversation";
      }
      return conversation;
    });
  }

  delete(id: string): Promise<boolean> {
    return this.#mutate((data) => {
      const before = data.conversations.length;
      data.conversations = data.conversations.filter((item) => item.id !== id);
      return data.conversations.length < before;
    });
  }
}

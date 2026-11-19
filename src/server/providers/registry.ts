import type { ProviderId, ProviderInfo } from "../../shared/types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import type { LlmAdapter } from "./types.js";

export class ProviderRegistry {
  readonly #adapters = new Map<ProviderId, LlmAdapter>();
  #defaultProviderId: ProviderId = "openai";

  register(adapter: LlmAdapter): void {
    this.#adapters.set(adapter.id, adapter);
  }

  get(id: ProviderId): LlmAdapter | undefined {
    return this.#adapters.get(id);
  }

  require(id: ProviderId): LlmAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new Error(`Unknown model provider: ${id}`);
    return adapter;
  }

  setDefault(id: ProviderId): void {
    if (!this.#adapters.has(id)) throw new Error(`Cannot set default to unregistered provider: ${id}`);
    this.#defaultProviderId = id;
  }

  getDefault(): LlmAdapter {
    const preferred = this.#adapters.get(this.#defaultProviderId);
    if (preferred?.isConfigured()) return preferred;
    for (const adapter of this.#adapters.values()) {
      if (adapter.isConfigured()) return adapter;
    }
    if (preferred) return preferred;
    const first = this.#adapters.values().next().value;
    if (!first) throw new Error("No LLM providers registered");
    return first;
  }

  listInfo(): ProviderInfo[] {
    return [...this.#adapters.values()].map((adapter) => adapter.info());
  }
}

export function createDefaultProviderRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const registry = new ProviderRegistry();

  registry.register(
    new OpenAICompatAdapter({
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
      apiKey: env.DEEPSEEK_API_KEY,
      defaultModel: env.DEEPSEEK_MODEL ?? "deepseek-chat",
      models: ["deepseek-chat", "deepseek-reasoner"],
      supportsReasoning: true,
    }),
  );

  registry.register(
    new OpenAICompatAdapter({
      id: "openai",
      label: "OpenAI",
      baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      defaultModel: env.OPENAI_MODEL ?? "gpt-4o-mini",
      models: ["gpt-5-mini", "gpt-5", "gpt-4o", "gpt-4o-mini", "o3-mini"],
      supportsReasoning: true,
    }),
  );

  registry.register(
    new AnthropicAdapter({
      apiKey: env.ANTHROPIC_API_KEY,
      baseUrl: env.ANTHROPIC_BASE_URL,
      defaultModel: env.ANTHROPIC_MODEL,
    }),
  );

  registry.register(
    new GeminiAdapter({
      apiKey: env.GEMINI_API_KEY,
      baseUrl: env.GEMINI_BASE_URL,
      defaultModel: env.GEMINI_MODEL,
    }),
  );

  registry.register(
    new OpenAICompatAdapter({
      id: "local",
      label: "Local LLM (Ollama / OpenAI-Compat)",
      baseUrl: env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:11434/v1",
      apiKey: env.LOCAL_LLM_API_KEY,
      requireApiKey: false,
      defaultModel: env.LOCAL_LLM_MODEL ?? "qwen2.5-coder:7b",
      models: [env.LOCAL_LLM_MODEL ?? "qwen2.5-coder:7b", "deepseek-r1:8b", "llama3.2:latest"],
      supportsReasoning: true,
    }),
  );

  const requestedDefault = env.FORGE_DEFAULT_PROVIDER as ProviderId | undefined;
  if (requestedDefault && registry.get(requestedDefault)) {
    registry.setDefault(requestedDefault);
  } else if (env.DEEPSEEK_API_KEY) {
    registry.setDefault("deepseek");
  } else if (env.OPENAI_API_KEY) {
    registry.setDefault("openai");
  } else if (env.ANTHROPIC_API_KEY) {
    registry.setDefault("anthropic");
  } else if (env.GEMINI_API_KEY) {
    registry.setDefault("gemini");
  } else {
    registry.setDefault("local");
  }

  return registry;
}

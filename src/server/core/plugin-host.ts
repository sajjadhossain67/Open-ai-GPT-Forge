import { Logger, rootLogger } from "./logger.js";

export type Disposer = () => void | Promise<void>;

export interface PluginContext {
  readonly logger: Logger;
  onDispose(disposer: Disposer): void;
  setService<T>(key: string, service: T): Disposer;
  getService<T>(key: string): T | undefined;
  requireService<T>(key: string): T;
  onHook<TInput, TOutput = TInput>(name: string, handler: HookHandler<TInput, TOutput>): Disposer;
  runWaterfall<T>(name: string, initial: T): Promise<T>;
  emitSerial<T>(name: string, payload: T): Promise<void>;
}

export type HookHandler<TInput, TOutput = TInput> = (
  payload: TInput,
  next: (updated: TInput) => Promise<TOutput>,
) => Promise<TOutput>;

export interface ForgePlugin {
  readonly name: string;
  readonly version?: string;
  setup(ctx: PluginContext): void | Promise<void>;
}

interface RegisteredPlugin {
  readonly name: string;
  readonly version: string;
  readonly disposers: Disposer[];
}

/**
 * Lightweight plugin and capability host inspired by DeepSeek Harness's Cordis runtime.
 * Every plugin registers services, lifecycle hooks, and cleanup disposers that unwind cleanly on unload.
 */
export class PluginHost {
  readonly #services = new Map<string, unknown>();
  readonly #hooks = new Map<string, Array<HookHandler<unknown, unknown>>>();
  readonly #plugins = new Map<string, RegisteredPlugin>();
  readonly #logger: Logger;

  constructor(logger: Logger = rootLogger.child("plugins")) {
    this.#logger = logger;
  }

  async mount(plugin: ForgePlugin): Promise<Disposer> {
    if (this.#plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already mounted`);
    }
    const record: RegisteredPlugin = {
      name: plugin.name,
      version: plugin.version ?? "1.0.0",
      disposers: [],
    };
    const ctx = this.#createContext(plugin.name, record.disposers);
    try {
      await plugin.setup(ctx);
      this.#plugins.set(plugin.name, record);
      this.#logger.debug("Plugin mounted", { plugin: plugin.name, version: record.version });
      return () => this.unmount(plugin.name);
    } catch (error) {
      await this.#runDisposers(record.disposers);
      throw error;
    }
  }

  async unmount(name: string): Promise<void> {
    const record = this.#plugins.get(name);
    if (!record) return;
    this.#plugins.delete(name);
    await this.#runDisposers(record.disposers);
    this.#logger.debug("Plugin unmounted", { plugin: name });
  }

  async disposeAll(): Promise<void> {
    const names = [...this.#plugins.keys()].reverse();
    for (const name of names) {
      await this.unmount(name);
    }
  }

  listPlugins(): Array<{ name: string; version: string }> {
    return [...this.#plugins.values()].map(({ name, version }) => ({ name, version }));
  }

  setService<T>(key: string, service: T): Disposer {
    this.#services.set(key, service);
    return () => {
      if (this.#services.get(key) === service) {
        this.#services.delete(key);
      }
    };
  }

  getService<T>(key: string): T | undefined {
    return this.#services.get(key) as T | undefined;
  }

  requireService<T>(key: string): T {
    const value = this.#services.get(key);
    if (value === undefined) throw new Error(`Required service "${key}" is not registered`);
    return value as T;
  }

  onHook<TInput, TOutput = TInput>(name: string, handler: HookHandler<TInput, TOutput>): Disposer {
    const list = this.#hooks.get(name) ?? [];
    list.push(handler as HookHandler<unknown, unknown>);
    this.#hooks.set(name, list);
    return () => {
      const current = this.#hooks.get(name);
      if (!current) return;
      const idx = current.indexOf(handler as HookHandler<unknown, unknown>);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  async runWaterfall<T>(name: string, initial: T): Promise<T> {
    const handlers = [...(this.#hooks.get(name) ?? [])];
    const dispatch = async (index: number, value: T): Promise<T> => {
      const handler = handlers[index];
      if (!handler) return value;
      return (await handler(value, (nextVal) => dispatch(index + 1, nextVal as T))) as T;
    };
    return dispatch(0, initial);
  }

  async emitSerial<T>(name: string, payload: T): Promise<void> {
    const handlers = [...(this.#hooks.get(name) ?? [])];
    for (const handler of handlers) {
      await handler(payload, async (v) => v);
    }
  }

  #createContext(pluginName: string, disposers: Disposer[]): PluginContext {
    return {
      logger: this.#logger.child(pluginName),
      onDispose: (disposer) => {
        disposers.push(disposer);
      },
      setService: (key, service) => {
        const d = this.setService(key, service);
        disposers.push(d);
        return d;
      },
      getService: (key) => this.getService(key),
      requireService: (key) => this.requireService(key),
      onHook: (name, handler) => {
        const d = this.onHook(name, handler);
        disposers.push(d);
        return d;
      },
      runWaterfall: (name, initial) => this.runWaterfall(name, initial),
      emitSerial: (name, payload) => this.emitSerial(name, payload),
    };
  }

  async #runDisposers(disposers: Disposer[]): Promise<void> {
    for (const disposer of [...disposers].reverse()) {
      try {
        await disposer();
      } catch (error) {
        this.#logger.warn("Error during plugin disposal", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

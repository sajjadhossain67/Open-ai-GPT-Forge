export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const SECRET_KEYS = /key|token|secret|password|authorization|cookie/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…[truncated]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  readonly #scope: string;
  #level: LogLevel;

  constructor(scope: string, level?: LogLevel) {
    this.#scope = scope;
    const envLevel = (process.env.LOG_LEVEL?.toLowerCase() ?? "info") as LogLevel;
    this.#level = level ?? (envLevel in LEVEL_ORDER ? envLevel : "info");
  }

  child(subScope: string): Logger {
    return new Logger(`${this.#scope}:${subScope}`, this.#level);
  }

  setLevel(level: LogLevel): void {
    this.#level = level;
  }

  #emit(level: Exclude<LogLevel, "silent">, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope: this.#scope,
      msg: message,
      ...(meta ? { meta: sanitize(meta) } : {}),
    };
    const line = JSON.stringify(entry);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.#emit("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.#emit("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.#emit("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.#emit("error", message, meta);
  }
}

export const rootLogger = new Logger("forge");

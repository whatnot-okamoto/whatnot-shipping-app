import type {
  RedisLike,
  RedisPipelineLike,
  RedisSetOptions,
} from "./redis-like";

type StoredValue = {
  value: unknown;
  expiresAt: number | null;
};

/**
 * ローカルmock専用の非永続Redis互換subset。
 * process再起動、Next.jsのHMR、複数process間では内容を保持・共有しない。
 * Production相当の永続性、atomicity、同時実行保証には使用しないこと。
 */
export class MemoryRedis implements RedisLike {
  private readonly values = new Map<string, StoredValue>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private deleteExpiredValue(key: string): void {
    const stored = this.values.get(key);
    if (
      stored &&
      stored.expiresAt !== null &&
      stored.expiresAt <= this.now()
    ) {
      this.values.delete(key);
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.deleteExpiredValue(key);
    const stored = this.values.get(key);
    return stored ? (structuredClone(stored.value) as T) : null;
  }

  async set(
    key: string,
    value: unknown,
    options: RedisSetOptions = {}
  ): Promise<"OK" | null> {
    this.deleteExpiredValue(key);
    if (options.nx && (this.values.has(key) || this.sets.has(key))) {
      return null;
    }
    this.sets.delete(key);
    this.values.set(key, {
      value: structuredClone(value),
      expiresAt: options.ex ? this.now() + options.ex * 1000 : null,
    });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      this.deleteExpiredValue(key);
      if (this.values.delete(key)) deleted += 1;
      if (this.sets.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    this.deleteExpiredValue(key);
    if (this.values.has(key)) {
      throw new Error("WRONGTYPE: key contains a non-set value");
    }
    const target = this.sets.get(key) ?? new Set<string>();
    const before = target.size;
    for (const member of members) target.add(String(member));
    this.sets.set(key, target);
    return target.size - before;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const target = this.sets.get(key);
    if (!target) return 0;
    let removed = 0;
    for (const member of members) {
      if (target.delete(String(member))) removed += 1;
    }
    if (target.size === 0) this.sets.delete(key);
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }

  async keys(pattern: string): Promise<string[]> {
    for (const key of this.values.keys()) this.deleteExpiredValue(key);
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
    const allKeys = new Set([...this.values.keys(), ...this.sets.keys()]);
    return [...allKeys].filter((key) => expression.test(key));
  }

  async compareAndDelete(
    key: string,
    expectedValue: string
  ): Promise<boolean> {
    this.deleteExpiredValue(key);
    const stored = this.values.get(key);
    if (!stored || stored.value !== expectedValue) return false;
    this.values.delete(key);
    return true;
  }

  async setIfValueMatches(
    guardKey: string,
    expectedGuardValue: string,
    targetKey: string,
    value: string
  ): Promise<boolean> {
    this.deleteExpiredValue(guardKey);
    const guard = this.values.get(guardKey);
    if (!guard || guard.value !== expectedGuardValue) return false;
    this.sets.delete(targetKey);
    this.values.set(targetKey, {
      value,
      expiresAt: null,
    });
    return true;
  }

  pipeline(): RedisPipelineLike {
    const commands: Array<() => Promise<unknown>> = [];
    const pipeline: RedisPipelineLike = {
      get: (key) => {
        commands.push(() => this.get(key));
        return pipeline;
      },
      set: (key, value, options) => {
        commands.push(() => this.set(key, value, options));
        return pipeline;
      },
      del: (...keys) => {
        commands.push(() => this.del(...keys));
        return pipeline;
      },
      sadd: (key, ...members) => {
        commands.push(() => this.sadd(key, ...members));
        return pipeline;
      },
      srem: (key, ...members) => {
        commands.push(() => this.srem(key, ...members));
        return pipeline;
      },
      exec: async () => {
        const results: unknown[] = [];
        for (const command of commands) results.push(await command());
        return results;
      },
    };
    return pipeline;
  }
}

type MemoryRedisGlobal = typeof globalThis & {
  __whatnotLocalMemoryRedis?: MemoryRedis;
};

export function getLocalMemoryRedis(): MemoryRedis {
  const globalStore = globalThis as MemoryRedisGlobal;
  globalStore.__whatnotLocalMemoryRedis ??= new MemoryRedis();
  return globalStore.__whatnotLocalMemoryRedis;
}

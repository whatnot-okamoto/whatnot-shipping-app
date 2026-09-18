import type {
  RedisLike,
  RedisMutation,
  RedisPipelineLike,
  RedisSetOptions,
} from "./redis-like";

type StoredValue = {
  value: unknown;
  expiresAt: number | null;
};

import { encodeWorkflowMset, encodeSessionStart, validateRawBatch, validateRawBatchKeys } from './redis-like';

/**
 * ローカルmock専用の非永続Redis互換subset。
 * process再起動、Next.jsのHMR、複数process間では内容を保持・共有しない。
 * Production相当の永続性、atomicity、同時実行保証には使用しないこと。
 */
export class MemoryRedis implements RedisLike {
  async getRawBatch(keys: string[]): Promise<string[]> {
    validateRawBatchKeys(keys);
    const values = keys.map(key => {
      this.deleteExpiredValue(key);
      if (this.sets.has(key)) throw new Error('M1_WRONG_TYPE');
      const value=this.values.get(key)?.value;
      if(value===undefined) throw new Error('M1_RAW_MISSING');
      return typeof value==='string'?value:JSON.stringify(value);
    });
    validateRawBatch(keys,values); return values;
  }
  async getRawString(key: string, maxBytes = 1024 * 1024): Promise<string | null> {
    this.deleteExpiredValue(key);
    if (this.sets.has(key)) throw new Error('M1_WRONG_TYPE');
    const value = this.values.get(key)?.value;
    if (value === undefined) return null;
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('M1_VALUE_LIMIT');
    return raw;
  }

  async workflowMset(
    guards: Array<{ key: string; expected: string | null }>,
    writes: Array<{ key: string; value: string }>
  ): Promise<boolean> {
    encodeWorkflowMset(guards, writes);
    // Deliberately no await between comparison and the single visible update.
    for (const guard of guards) {
      this.deleteExpiredValue(guard.key);
      if (this.sets.has(guard.key)) throw new Error('M1_WRONG_TYPE');
      const value = this.values.get(guard.key)?.value;
      const raw = value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);
      if (raw !== guard.expected) return false;
    }
    for (const write of writes) {
      this.deleteExpiredValue(write.key);
      if (this.sets.has(write.key)) throw new Error('M1_WRONG_TYPE');
    }
    for (const write of writes) this.values.set(write.key, { value: write.value, expiresAt: null });
    return true;
  }
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

  async compareAndExpire(
    key: string,
    expectedValue: string,
    ttlSeconds: number
  ): Promise<boolean> {
    this.deleteExpiredValue(key);
    const stored = this.values.get(key);
    if (!stored || stored.value !== expectedValue) return false;
    stored.expiresAt = this.now() + ttlSeconds * 1000;
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

  async fencedMutate(
    leaseKey: string,
    expectedLeaseValue: string,
    mutations: RedisMutation[]
  ) {
    this.deleteExpiredValue(leaseKey);
    const lease = this.values.get(leaseKey);
    if (!lease || lease.value !== expectedLeaseValue) {
      return { applied: false as const, reason: "lease_lost" as const };
    }

    const results: unknown[] = [];
    for (const mutation of mutations) {
      switch (mutation.type) {
        case "set": {
          this.deleteExpiredValue(mutation.key);
          this.sets.delete(mutation.key);
          this.values.set(mutation.key, {
            value: structuredClone(mutation.value),
            expiresAt: null,
          });
          results.push("OK");
          break;
        }
        case "set_nx": {
          this.deleteExpiredValue(mutation.key);
          if (this.values.has(mutation.key) || this.sets.has(mutation.key)) {
            results.push(null);
          } else {
            this.values.set(mutation.key, {
              value: structuredClone(mutation.value),
              expiresAt: null,
            });
            results.push("OK");
          }
          break;
        }
        case "del": {
          let deleted = 0;
          for (const key of mutation.keys) {
            this.deleteExpiredValue(key);
            if (this.values.delete(key)) deleted += 1;
            if (this.sets.delete(key)) deleted += 1;
          }
          results.push(deleted);
          break;
        }
        case "sadd": {
          this.deleteExpiredValue(mutation.key);
          if (this.values.has(mutation.key)) {
            throw new Error("WRONGTYPE: key contains a non-set value");
          }
          const target = this.sets.get(mutation.key) ?? new Set<string>();
          const before = target.size;
          for (const member of mutation.members) target.add(String(member));
          this.sets.set(mutation.key, target);
          results.push(target.size - before);
          break;
        }
        case "srem": {
          const target = this.sets.get(mutation.key);
          let removed = 0;
          if (target) {
            for (const member of mutation.members) {
              if (target.delete(String(member))) removed += 1;
            }
            if (target.size === 0) this.sets.delete(mutation.key);
          }
          results.push(removed);
          break;
        }
      }
    }
    return { applied: true as const, results };
  }

  async fencedStartSession(
    leaseKey: string,
    expectedLeaseValue: string,
    currentSessionKey: string,
    currentSessionValue: string,
    candidateSessionKey: string,
    candidateSessionValue: unknown,
    refetchStateKey: string,
    guards: Array<{ key: string; expected: string | null }> = []
  ) {
    encodeSessionStart([leaseKey,currentSessionKey,candidateSessionKey,refetchStateKey],expectedLeaseValue,
      currentSessionValue,typeof candidateSessionValue==='string'?candidateSessionValue:JSON.stringify(candidateSessionValue),guards);
    this.deleteExpiredValue(leaseKey);
    const lease = this.values.get(leaseKey);
    if (!lease || lease.value !== expectedLeaseValue) {
      return { status: "lease_lost" as const };
    }

    this.deleteExpiredValue(currentSessionKey);
    if (this.values.has(currentSessionKey) || this.sets.has(currentSessionKey)) return { status: 'session_exists' as const };
    this.deleteExpiredValue(candidateSessionKey);
    if (this.values.has(candidateSessionKey) || this.sets.has(candidateSessionKey)) throw new Error('M1_SESSION_CANDIDATE_EXISTS');
    for (const guard of guards) {
      this.deleteExpiredValue(guard.key);
      if (this.sets.has(guard.key)) throw new Error('M1_WRONG_TYPE');
      const value = this.values.get(guard.key)?.value;
      const raw = value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);
      if (raw !== guard.expected) throw new Error('M1_STATE_CHANGED');
    }
    this.deleteExpiredValue(currentSessionKey);
    if (this.values.has(currentSessionKey) || this.sets.has(currentSessionKey)) {
      return { status: "session_exists" as const };
    }

    // No await occurs between the NX decision and these writes: this is one
    // atomic operation in the in-memory adapter, matching the Lua contract.
    this.sets.delete(currentSessionKey);
    this.values.set(currentSessionKey, {
      value: currentSessionValue,
      expiresAt: null,
    });
    this.sets.delete(candidateSessionKey);
    this.values.set(candidateSessionKey, {
      value: structuredClone(candidateSessionValue),
      expiresAt: null,
    });
    this.values.delete(refetchStateKey);
    this.sets.delete(refetchStateKey);
    return { status: "created" as const };
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

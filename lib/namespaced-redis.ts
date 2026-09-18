import type {
  RedisLike,
  RedisMutation,
  RedisPipelineLike,
  RedisSetOptions,
} from "./redis-like";

/**
 * RedisLikeのkey引数は、保存先に依存しない論理キーとして扱う。
 * 呼び出し側が物理namespaceを付与することは禁止し、この境界だけで変換する。
 */
export const DEVELOPMENT_REDIS_NAMESPACE = "dev:v1:";

const RESERVED_DEVELOPMENT_PREFIX = "dev:";
const DEVELOPMENT_REDIS_BRAND = Symbol("DevelopmentRedisLike");

export interface DevelopmentRedisLike extends RedisLike {
  readonly [DEVELOPMENT_REDIS_BRAND]: true;
}

function assertLogicalKey(key: string): void {
  if (!key) {
    throw new Error("[redis-namespace] Empty Redis keys are not allowed.");
  }
  if (key.startsWith(RESERVED_DEVELOPMENT_PREFIX)) {
    throw new Error(
      "[redis-namespace] Callers must not use the reserved Development Redis prefix."
    );
  }
}

function getLiteralPatternPrefix(pattern: string): string {
  let prefix = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined) {
        throw new Error("[redis-namespace] Invalid trailing escape in KEYS pattern.");
      }
      prefix += escaped;
      index += 1;
      continue;
    }
    if (character === "*" || character === "?" || character === "[") break;
    prefix += character;
  }
  return prefix;
}

function assertProductionPattern(pattern: string): void {
  if (!pattern) {
    throw new Error("[redis-namespace] Empty KEYS patterns are not allowed.");
  }
  const literalPrefix = getLiteralPatternPrefix(pattern);
  const canReachDevelopment =
    literalPrefix.length === 0 ||
    RESERVED_DEVELOPMENT_PREFIX.startsWith(literalPrefix) ||
    literalPrefix.startsWith(RESERVED_DEVELOPMENT_PREFIX);
  if (canReachDevelopment) {
    throw new Error(
      "[redis-namespace] Production KEYS pattern could reach the Development namespace."
    );
  }
}

type KeyPolicy = {
  key(logicalKey: string): string;
  pattern(logicalPattern: string): string;
  result(physicalKey: string): string;
};

class GuardedRedis implements RedisLike {
  getRawString(key: string, maxBytes?: number): Promise<string | null> {
    return this.target.getRawString(this.policy.key(key), maxBytes);
  }

  workflowMset(
    guards: Array<{ key: string; expected: string | null }>,
    writes: Array<{ key: string; value: string }>
  ): Promise<boolean> {
    return this.target.workflowMset(
      guards.map(g => ({ ...g, key: this.policy.key(g.key) })),
      writes.map(w => ({ ...w, key: this.policy.key(w.key) }))
    );
  }
  private readonly target: RedisLike;
  private readonly policy: KeyPolicy;

  constructor(target: RedisLike, policy: KeyPolicy) {
    this.target = target;
    this.policy = policy;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.target.get<T>(this.policy.key(key));
  }

  async set(
    key: string,
    value: unknown,
    options?: RedisSetOptions
  ): Promise<"OK" | null> {
    return this.target.set(this.policy.key(key), value, options);
  }

  async del(...keys: string[]): Promise<number> {
    return this.target.del(...keys.map((key) => this.policy.key(key)));
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.target.sadd(this.policy.key(key), ...members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return this.target.srem(this.policy.key(key), ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.target.smembers(this.policy.key(key));
  }

  async keys(pattern: string): Promise<string[]> {
    const physicalKeys = await this.target.keys(this.policy.pattern(pattern));
    return physicalKeys.map((key) => this.policy.result(key));
  }

  async compareAndDelete(
    key: string,
    expectedValue: string
  ): Promise<boolean> {
    return this.target.compareAndDelete(
      this.policy.key(key),
      expectedValue
    );
  }

  async compareAndExpire(
    key: string,
    expectedValue: string,
    ttlSeconds: number
  ): Promise<boolean> {
    return this.target.compareAndExpire(
      this.policy.key(key),
      expectedValue,
      ttlSeconds
    );
  }

  async setIfValueMatches(
    guardKey: string,
    expectedGuardValue: string,
    targetKey: string,
    value: string
  ): Promise<boolean> {
    return this.target.setIfValueMatches(
      this.policy.key(guardKey),
      expectedGuardValue,
      this.policy.key(targetKey),
      value
    );
  }

  async fencedMutate(
    leaseKey: string,
    expectedLeaseValue: string,
    mutations: RedisMutation[]
  ) {
    const mapped = mutations.map((mutation): RedisMutation => {
      switch (mutation.type) {
        case "set":
        case "set_nx":
          return { ...mutation, key: this.policy.key(mutation.key) };
        case "del":
          return {
            ...mutation,
            keys: mutation.keys.map((key) => this.policy.key(key)),
          };
        case "sadd":
        case "srem":
          return { ...mutation, key: this.policy.key(mutation.key) };
      }
    });
    return this.target.fencedMutate(
      this.policy.key(leaseKey),
      expectedLeaseValue,
      mapped
    );
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
    return this.target.fencedStartSession(
      this.policy.key(leaseKey),
      expectedLeaseValue,
      this.policy.key(currentSessionKey),
      currentSessionValue,
      this.policy.key(candidateSessionKey),
      candidateSessionValue,
      this.policy.key(refetchStateKey),
      guards.map(g => ({ ...g, key: this.policy.key(g.key) }))
    );
  }

  pipeline(): RedisPipelineLike {
    const target = this.target.pipeline();
    const pipeline: RedisPipelineLike = {
      get: (key) => {
        target.get(this.policy.key(key));
        return pipeline;
      },
      set: (key, value, options) => {
        target.set(this.policy.key(key), value, options);
        return pipeline;
      },
      del: (...keys) => {
        target.del(...keys.map((key) => this.policy.key(key)));
        return pipeline;
      },
      sadd: (key, ...members) => {
        target.sadd(this.policy.key(key), ...members);
        return pipeline;
      },
      srem: (key, ...members) => {
        target.srem(this.policy.key(key), ...members);
        return pipeline;
      },
      exec: () => target.exec(),
    };
    return pipeline;
  }
}

export function createDevelopmentRedis(target: RedisLike): DevelopmentRedisLike {
  const policy: KeyPolicy = {
    key: (logicalKey) => {
      assertLogicalKey(logicalKey);
      return `${DEVELOPMENT_REDIS_NAMESPACE}${logicalKey}`;
    },
    pattern: (logicalPattern) => {
      assertLogicalKey(logicalPattern);
      return `${DEVELOPMENT_REDIS_NAMESPACE}${logicalPattern}`;
    },
    result: (physicalKey) => {
      if (!physicalKey.startsWith(DEVELOPMENT_REDIS_NAMESPACE)) {
        throw new Error(
          "[redis-namespace] Upstash returned a key outside the Development namespace."
        );
      }
      const logicalKey = physicalKey.slice(DEVELOPMENT_REDIS_NAMESPACE.length);
      assertLogicalKey(logicalKey);
      return logicalKey;
    },
  };
  const guarded = new GuardedRedis(target, policy) as unknown as DevelopmentRedisLike;
  Object.defineProperty(guarded, DEVELOPMENT_REDIS_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return guarded;
}

export function assertDevelopmentRedis(
  target: RedisLike
): asserts target is DevelopmentRedisLike {
  if (
    typeof target !== "object" ||
    target === null ||
    !(DEVELOPMENT_REDIS_BRAND in target)
  ) {
    throw new Error(
      "[redis-namespace] Development OAuth requires the namespaced Development Redis adapter."
    );
  }
}

export function createProductionRedis(target: RedisLike): RedisLike {
  const policy: KeyPolicy = {
    key: (logicalKey) => {
      assertLogicalKey(logicalKey);
      return logicalKey;
    },
    pattern: (logicalPattern) => {
      assertProductionPattern(logicalPattern);
      return logicalPattern;
    },
    result: (physicalKey) => {
      assertLogicalKey(physicalKey);
      return physicalKey;
    },
  };
  return new GuardedRedis(target, policy);
}

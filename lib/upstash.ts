import { Redis } from "@upstash/redis";
import { getLocalMemoryRedis } from "@/lib/memory-redis";
import {
  assertDevelopmentRedis,
  createDevelopmentRedis,
  createProductionRedis,
  type DevelopmentRedisLike,
} from "@/lib/namespaced-redis";
import type { RedisLike } from "@/lib/redis-like";
import type {
  RedisPipelineLike,
  RedisSetOptions,
} from "@/lib/redis-like";
import {
  assertDevelopmentRuntime,
  resolveRuntimeConfig,
} from "@/lib/runtime-mode";

const runtimeConfig = resolveRuntimeConfig();
const DEVELOPMENT_ATOMIC_REQUEST_TIMEOUT_MS = 10_000;

const COMPARE_AND_DELETE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return 1
end
return 0
`;

const SET_IF_VALUE_MATCHES_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[2], ARGV[2])
  return 1
end
return 0
`;

function parseAtomicBoolean(result: unknown): boolean {
  if (result === 1) return true;
  if (result === 0) return false;
  throw new Error("[redis-atomic] Redis returned an invalid script result.");
}

class UpstashRedisAdapter implements RedisLike {
  constructor(private readonly client: Redis) {}

  get<T = unknown>(key: string): Promise<T | null> {
    return this.client.get<T>(key);
  }

  async set(
    key: string,
    value: unknown,
    options?: RedisSetOptions
  ): Promise<"OK" | null> {
    let result: unknown;
    if (options?.nx && options.ex !== undefined) {
      result = await this.client.set(key, value, { nx: true, ex: options.ex });
    } else if (options?.nx) {
      result = await this.client.set(key, value, { nx: true });
    } else if (options?.ex !== undefined) {
      result = await this.client.set(key, value, { ex: options.ex });
    } else {
      result = await this.client.set(key, value);
    }
    if (result === "OK" || result === null) return result;
    throw new Error("[redis-adapter] Redis returned an invalid SET result.");
  }

  del(...keys: string[]): Promise<number> {
    return this.client.del(...keys);
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return Promise.resolve(0);
    const sadd = this.client.sadd.bind(this.client) as (
      targetKey: string,
      ...targetMembers: string[]
    ) => Promise<number>;
    return sadd(key, ...members);
  }

  srem(key: string, ...members: string[]): Promise<number> {
    return this.client.srem(key, ...members);
  }

  smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }

  async compareAndDelete(
    key: string,
    expectedValue: string
  ): Promise<boolean> {
    const result: unknown = await this.client.eval(
      COMPARE_AND_DELETE_SCRIPT,
      [key],
      [expectedValue]
    );
    return parseAtomicBoolean(result);
  }

  async setIfValueMatches(
    guardKey: string,
    expectedGuardValue: string,
    targetKey: string,
    value: string
  ): Promise<boolean> {
    const result: unknown = await this.client.eval(
      SET_IF_VALUE_MATCHES_SCRIPT,
      [guardKey, targetKey],
      [expectedGuardValue, value]
    );
    return parseAtomicBoolean(result);
  }

  pipeline(): RedisPipelineLike {
    return this.client.pipeline() as unknown as RedisPipelineLike;
  }
}

function createRedisClient(): RedisLike {
  if (runtimeConfig.appStoreMode === "memory") {
    return getLocalMemoryRedis();
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set for upstash mode"
    );
  }

  // raw clientはこの境界からexportせず、必ずruntime別のkey policyを通す。
  const rawClient = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  const target: RedisLike = new UpstashRedisAdapter(rawClient);

  return runtimeConfig.appEnvironment === "development"
    ? createDevelopmentRedis(target)
    : createProductionRedis(target);
}

export const redis = createRedisClient();

/**
 * Creates the fixed Development atomic diagnostic transport.
 *
 * This is intentionally separate from the normal runtime singleton so the
 * diagnostic can disable transport retries without changing Production or
 * Development application behavior. The raw client is never exported.
 */
export function createDevelopmentAtomicVerificationRedis(): DevelopmentRedisLike {
  assertDevelopmentRuntime(
    runtimeConfig,
    "Development Upstash atomic verification"
  );

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set for atomic verification"
    );
  }

  const rawClient = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    retry: false,
    signal: () => AbortSignal.timeout(DEVELOPMENT_ATOMIC_REQUEST_TIMEOUT_MS),
  });
  const namespaced = createDevelopmentRedis(new UpstashRedisAdapter(rawClient));
  assertDevelopmentRedis(namespaced);
  return namespaced;
}

export const DEVELOPMENT_ATOMIC_VERIFICATION_TIMEOUT_MS =
  DEVELOPMENT_ATOMIC_REQUEST_TIMEOUT_MS;

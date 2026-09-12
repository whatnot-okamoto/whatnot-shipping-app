import { Redis } from "@upstash/redis";
import { getLocalMemoryRedis } from "@/lib/memory-redis";
import {
  assertDevelopmentRedis,
  createDevelopmentRedis,
  createProductionRedis,
  type DevelopmentRedisLike,
} from "@/lib/namespaced-redis";
import type { RedisLike, RedisMutation } from "@/lib/redis-like";
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

const COMPARE_AND_EXPIRE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
  return 1
end
return 0
`;

const FENCED_MUTATE_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then
  return {0}
end
local mutations = cjson.decode(ARGV[2])
local results = {1}
for _, mutation in ipairs(mutations) do
  local command = mutation.type
  if command == "set" then
    table.insert(results, redis.call("SET", KEYS[mutation.key], mutation.value))
  elseif command == "set_nx" then
    local result = redis.call("SET", KEYS[mutation.key], mutation.value, "NX")
    table.insert(results, result and 1 or 0)
  elseif command == "del" then
    local keys = {}
    for _, keyIndex in ipairs(mutation.keys) do
      table.insert(keys, KEYS[keyIndex])
    end
    table.insert(results, redis.call("DEL", unpack(keys)))
  elseif command == "sadd" then
    table.insert(results, redis.call("SADD", KEYS[mutation.key], unpack(mutation.members)))
  elseif command == "srem" then
    table.insert(results, redis.call("SREM", KEYS[mutation.key], unpack(mutation.members)))
  else
    return redis.error_reply("Unsupported fenced mutation")
  end
end
return results
`;

const FENCED_START_SESSION_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then
  return -1
end
local acquired = redis.call("SET", KEYS[2], ARGV[2], "NX")
if not acquired then
  return 0
end
redis.call("SET", KEYS[3], ARGV[3])
redis.call("DEL", KEYS[4])
return 1
`;

function serializeRedisValue(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function serializeFencedMutations(
  leaseKey: string,
  mutations: RedisMutation[]
): { keys: string[]; payload: string } {
  const keys = [leaseKey];
  const indexes = new Map<string, number>([[leaseKey, 1]]);
  const keyIndex = (key: string): number => {
    const existing = indexes.get(key);
    if (existing !== undefined) return existing;
    keys.push(key);
    indexes.set(key, keys.length);
    return keys.length;
  };
  const encoded = mutations.map((mutation) => {
    switch (mutation.type) {
      case "set":
      case "set_nx":
        return {
          ...mutation,
          key: keyIndex(mutation.key),
          value: serializeRedisValue(mutation.value),
        };
      case "del":
        return { ...mutation, keys: mutation.keys.map(keyIndex) };
      case "sadd":
      case "srem":
        return { ...mutation, key: keyIndex(mutation.key) };
    }
  });
  return { keys, payload: JSON.stringify(encoded) };
}

function parseAtomicBoolean(result: unknown): boolean {
  if (result === 1) return true;
  if (result === 0) return false;
  throw new Error("[redis-atomic] Redis returned an invalid script result.");
}

class UpstashRedisAdapter implements RedisLike {
  private readonly client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

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

  async compareAndExpire(
    key: string,
    expectedValue: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const result: unknown = await this.client.eval(
      COMPARE_AND_EXPIRE_SCRIPT,
      [key],
      [expectedValue, String(ttlSeconds)]
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

  async fencedMutate(
    leaseKey: string,
    expectedLeaseValue: string,
    mutations: RedisMutation[]
  ) {
    const serialized = serializeFencedMutations(leaseKey, mutations);
    const result: unknown = await this.client.eval(
      FENCED_MUTATE_SCRIPT,
      serialized.keys,
      [expectedLeaseValue, serialized.payload]
    );
    if (!Array.isArray(result) || (result[0] !== 0 && result[0] !== 1)) {
      throw new Error("[redis-atomic] Redis returned an invalid fenced mutation result.");
    }
    return result[0] === 0
      ? { applied: false as const, reason: "lease_lost" as const }
      : { applied: true as const, results: result.slice(1) };
  }

  async fencedStartSession(
    leaseKey: string,
    expectedLeaseValue: string,
    currentSessionKey: string,
    currentSessionValue: string,
    candidateSessionKey: string,
    candidateSessionValue: unknown,
    refetchStateKey: string
  ) {
    const result: unknown = await this.client.eval(
      FENCED_START_SESSION_SCRIPT,
      [leaseKey, currentSessionKey, candidateSessionKey, refetchStateKey],
      [
        expectedLeaseValue,
        currentSessionValue,
        serializeRedisValue(candidateSessionValue),
      ]
    );
    if (result === 1) return { status: "created" as const };
    if (result === 0) return { status: "session_exists" as const };
    if (result === -1) return { status: "lease_lost" as const };
    throw new Error("[redis-atomic] Redis returned an invalid session start result.");
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
    // SDK 1.37.0 maps retry:false to one retry; retries:0 is one fetch total.
    retry: { retries: 0 },
    signal: () => AbortSignal.timeout(DEVELOPMENT_ATOMIC_REQUEST_TIMEOUT_MS),
  });
  const namespaced = createDevelopmentRedis(new UpstashRedisAdapter(rawClient));
  assertDevelopmentRedis(namespaced);
  return namespaced;
}

export const DEVELOPMENT_ATOMIC_VERIFICATION_TIMEOUT_MS =
  DEVELOPMENT_ATOMIC_REQUEST_TIMEOUT_MS;

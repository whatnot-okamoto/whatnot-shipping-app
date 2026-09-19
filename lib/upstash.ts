import { Redis } from "@upstash/redis";
import { encodeWorkflowMset, WORKFLOW_MSET_SCRIPT, RAW_BATCH_SCRIPT, validateRawBatchKeys,
  validateRawBatch, encodeSessionStart, SESSION_START_SCRIPT } from './redis-like';
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

export class UpstashRedisAdapter implements RedisLike {
  exists(key: string): Promise<number> {
    return this.client.exists(key);
  }
  async getRawBatch(keys: string[]): Promise<string[]> {
    validateRawBatchKeys(keys);
    const results=await this.client.pipeline().eval(RAW_BATCH_SCRIPT,keys,[]).exec();
    if(results.length!==1) throw new Error('M1_RAW_RESPONSE');
    const result: unknown=results[0];
    if(typeof result!=='string'||!result.startsWith('RAW:')||Buffer.byteLength(result)>1048576)
      throw new Error('M1_RAW_RESPONSE');
    const values: unknown=JSON.parse(result.slice(4));
    validateRawBatch(keys,values); return values;
  }
  async getRawString(key: string, maxBytes = 1024 * 1024): Promise<string | null> {
    // Prefix defeats SDK automatic JSON deserialization and preserves source bytes.
    const value = await this.client.eval(
      "local v=redis.call('GET',KEYS[1]); if not v then return false end; if string.len(v)>tonumber(ARGV[1]) then return redis.error_reply('M1_VALUE_LIMIT') end; return 'RAW:'..v",
      [key], [String(maxBytes)]
    );
    if (value === null || value === false) return null;
    if (typeof value !== 'string' || !value.startsWith('RAW:')) throw new Error('M1_RAW_RESPONSE');
    return value.slice(4);
  }

  async workflowMset(
    guards: Array<{ key: string; expected: string | null }>,
    writes: Array<{ key: string; value: string }>
  ): Promise<boolean> {
    const command = encodeWorkflowMset(guards, writes);
    // Explicit one-command pipeline prevents SDK automatic coalescing with unrelated requests.
    const values = await this.client.pipeline().eval(WORKFLOW_MSET_SCRIPT, command.keys, [command.payload]).exec();
    return parseAtomicBoolean(values[0]);
  }
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
    refetchStateKey: string,
    guards: Array<{ key: string; expected: string | null }> = []
  ) {
    const command=encodeSessionStart([leaseKey,currentSessionKey,candidateSessionKey,refetchStateKey],
      expectedLeaseValue,currentSessionValue,serializeRedisValue(candidateSessionValue),guards);
    const results=await this.client.pipeline().eval(SESSION_START_SCRIPT,command.keys,command.args).exec();
    if(results.length!==1) throw new Error('M1_SESSION_RESPONSE');
    const result: unknown=results[0];
    if (result === 1) return { status: "created" as const };
    if (result === 0) return { status: "session_exists" as const };
    if (result === -1) return { status: "lease_lost" as const };
    if (result === -2) throw new Error('M1_SESSION_DATA_CHANGED');
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

/** Temporary maintenance reader: existing SDK/adapter, Production credentials stay here.
 * SDK default retry is retained (5 retries, at most 6 fetch attempts per logical read).
 * No changes to the normal workflow singleton. No raw SDK client is exported.
 */
export function createM1ProductionReader(signal: AbortSignal): Pick<RedisLike, 'exists' | 'getRawString'> {
  if (runtimeConfig.appEnvironment !== 'production' || runtimeConfig.vercelEnvironment !== 'production' ||
      runtimeConfig.appStoreMode !== 'upstash') throw new Error('M1_MAINTENANCE_UNAVAILABLE');
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('M1_MAINTENANCE_UNAVAILABLE');
  const reader = createProductionRedis(new UpstashRedisAdapter(new Redis({
    url, token, enableAutoPipelining: false,
    signal: () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })));
  return { exists: key => reader.exists(key), getRawString: (key, limit) => reader.getRawString(key, limit) };
}

/** One-time CLI only: explicit target, no environment fallback or automatic retry. */
export function createExplicitMigrationRedis(url: string, token: string): RedisLike {
  if (!url || !token || !url.startsWith('https://')) throw new Error('M1_CLI_TARGET');
  return new UpstashRedisAdapter(new Redis({ url, token, retry: { retries: 0 },
    enableAutoPipelining: false, signal: () => AbortSignal.timeout(15_000) }));
}

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

import { Redis } from "@upstash/redis";
import { getLocalMemoryRedis } from "@/lib/memory-redis";
import {
  createDevelopmentRedis,
  createProductionRedis,
} from "@/lib/namespaced-redis";
import type { RedisLike } from "@/lib/redis-like";
import { resolveRuntimeConfig } from "@/lib/runtime-mode";

const runtimeConfig = resolveRuntimeConfig();

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
  const target = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  }) as unknown as RedisLike;

  return runtimeConfig.appEnvironment === "development"
    ? createDevelopmentRedis(target)
    : createProductionRedis(target);
}

export const redis = createRedisClient();

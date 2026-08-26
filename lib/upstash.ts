import { Redis } from "@upstash/redis";
import { getLocalMemoryRedis } from "@/lib/memory-redis";
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

  // Appが使用するRedis command subsetはRedisLikeで明示し、外部client型を境界内に閉じ込める。
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  }) as unknown as RedisLike;
}

export const redis = createRedisClient();

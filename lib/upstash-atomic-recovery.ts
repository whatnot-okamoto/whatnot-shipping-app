import {
  assertDevelopmentRedis,
  type DevelopmentRedisLike,
} from "./namespaced-redis";
import type { RedisLike } from "./redis-like";
import {
  UPSTASH_ATOMIC_DIAGNOSTIC_DUMMY_VALUES,
  UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY,
  UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY,
} from "./upstash-atomic-contract";

export type UpstashAtomicRecoveryClassification =
  | "PASS_RECOVERY_COMPLETE"
  | "STOP_RECOVERY_VALUE_UNEXPECTED"
  | "STOP_RECOVERY_INDETERMINATE"
  | "STOP_RUNTIME_BOUNDARY";

function requireDevelopmentRedis(
  redis: RedisLike
): DevelopmentRedisLike | null {
  try {
    assertDevelopmentRedis(redis);
    return redis;
  } catch {
    return null;
  }
}

function isAllowedDummyValue(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      UPSTASH_ATOMIC_DIAGNOSTIC_DUMMY_VALUES.some(
        (candidate) => candidate === value
      ))
  );
}

export async function runUpstashAtomicRecovery(
  candidate: RedisLike
): Promise<UpstashAtomicRecoveryClassification> {
  const redis = requireDevelopmentRedis(candidate);
  if (!redis) return "STOP_RUNTIME_BOUNDARY";

  try {
    const guard = await redis.get<unknown>(
      UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY
    );
    const target = await redis.get<unknown>(
      UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY
    );
    if (!isAllowedDummyValue(guard) || !isAllowedDummyValue(target)) {
      return "STOP_RECOVERY_VALUE_UNEXPECTED";
    }

    if (
      guard !== null &&
      (await redis.compareAndDelete(
        UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY,
        guard
      )) !== true
    ) {
      return "STOP_RECOVERY_INDETERMINATE";
    }

    if (
      target !== null &&
      (await redis.compareAndDelete(
        UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY,
        target
      )) !== true
    ) {
      return "STOP_RECOVERY_INDETERMINATE";
    }

    const finalGuard = await redis.get<unknown>(
      UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY
    );
    const finalTarget = await redis.get<unknown>(
      UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY
    );
    if (finalGuard !== null || finalTarget !== null) {
      return "STOP_RECOVERY_INDETERMINATE";
    }

    return "PASS_RECOVERY_COMPLETE";
  } catch {
    // Never retry or inspect again after a transport-uncertain operation.
    return "STOP_RECOVERY_INDETERMINATE";
  }
}

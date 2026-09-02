import {
  assertDevelopmentRedis,
  type DevelopmentRedisLike,
} from "./namespaced-redis";
import type { RedisLike } from "./redis-like";
import {
  UPSTASH_ATOMIC_DIAGNOSTIC_G1,
  UPSTASH_ATOMIC_DIAGNOSTIC_G1_ORDER_DIFFERENT,
  UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY,
  UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_TTL_SECONDS,
  UPSTASH_ATOMIC_DIAGNOSTIC_T1,
  UPSTASH_ATOMIC_DIAGNOSTIC_T2,
  UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY,
} from "./upstash-atomic-contract";

export type UpstashAtomicDiagnosticClassification =
  | "PASS_ATOMIC_CONTRACT"
  | "STOP_DIAGNOSTIC_KEYS_PRESENT"
  | "STOP_CONTRACT_MISMATCH"
  | "STOP_ATOMIC_INDETERMINATE"
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

export async function runUpstashAtomicDiagnostic(
  candidate: RedisLike
): Promise<UpstashAtomicDiagnosticClassification> {
  const redis = requireDevelopmentRedis(candidate);
  if (!redis) return "STOP_RUNTIME_BOUNDARY";

  try {
    const initialGuard = await redis.get<unknown>(
      UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY
    );
    const initialTarget = await redis.get<unknown>(
      UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY
    );
    if (initialGuard !== null || initialTarget !== null) {
      return "STOP_DIAGNOSTIC_KEYS_PRESENT";
    }

    const guardCreated = await redis.set(
      UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY,
      UPSTASH_ATOMIC_DIAGNOSTIC_G1,
      { nx: true, ex: UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_TTL_SECONDS }
    );
    if (guardCreated !== "OK") return "STOP_CONTRACT_MISMATCH";

    const mismatchedGuardWrite = await redis.setIfValueMatches(
      UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY,
      UPSTASH_ATOMIC_DIAGNOSTIC_G1_ORDER_DIFFERENT,
      UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY,
      UPSTASH_ATOMIC_DIAGNOSTIC_T2
    );
    if (mismatchedGuardWrite !== false) return "STOP_CONTRACT_MISMATCH";
    if (
      (await redis.get<unknown>(UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY)) !==
      null
    ) {
      return "STOP_CONTRACT_MISMATCH";
    }

    const matchedGuardWrite = await redis.setIfValueMatches(
      UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY,
      UPSTASH_ATOMIC_DIAGNOSTIC_G1,
      UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY,
      UPSTASH_ATOMIC_DIAGNOSTIC_T1
    );
    if (matchedGuardWrite !== true) return "STOP_CONTRACT_MISMATCH";
    if (
      (await redis.get<unknown>(UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY)) !==
      UPSTASH_ATOMIC_DIAGNOSTIC_T1
    ) {
      return "STOP_CONTRACT_MISMATCH";
    }

    const mismatchedOwnerDelete = await redis.compareAndDelete(
      UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY,
      UPSTASH_ATOMIC_DIAGNOSTIC_T2
    );
    if (mismatchedOwnerDelete !== false) return "STOP_CONTRACT_MISMATCH";
    if (
      (await redis.get<unknown>(UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY)) !==
      UPSTASH_ATOMIC_DIAGNOSTIC_T1
    ) {
      return "STOP_CONTRACT_MISMATCH";
    }

    const matchedOwnerDelete = await redis.compareAndDelete(
      UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY,
      UPSTASH_ATOMIC_DIAGNOSTIC_T1
    );
    if (matchedOwnerDelete !== true) return "STOP_CONTRACT_MISMATCH";

    const missingTargetDelete = await redis.compareAndDelete(
      UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY,
      UPSTASH_ATOMIC_DIAGNOSTIC_T1
    );
    if (missingTargetDelete !== false) return "STOP_CONTRACT_MISMATCH";

    const guardDeleted = await redis.compareAndDelete(
      UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY,
      UPSTASH_ATOMIC_DIAGNOSTIC_G1
    );
    if (guardDeleted !== true) return "STOP_CONTRACT_MISMATCH";

    const missingGuardWrite = await redis.setIfValueMatches(
      UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY,
      UPSTASH_ATOMIC_DIAGNOSTIC_G1,
      UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY,
      UPSTASH_ATOMIC_DIAGNOSTIC_T2
    );
    if (missingGuardWrite !== false) return "STOP_CONTRACT_MISMATCH";

    const finalGuard = await redis.get<unknown>(
      UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY
    );
    const finalTarget = await redis.get<unknown>(
      UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY
    );
    if (finalGuard !== null || finalTarget !== null) {
      return "STOP_CONTRACT_MISMATCH";
    }

    // PASS is limited to these fixed Redis operations. It does not validate
    // the OAuth canonical parser, control/lease runtime, real token records,
    // or an intentionally reproduced transport failure.
    return "PASS_ATOMIC_CONTRACT";
  } catch {
    // A transport timeout or any other uncertain result ends this process's
    // Redis activity. Recovery is a separate, explicitly invoked CLI.
    return "STOP_ATOMIC_INDETERMINATE";
  }
}

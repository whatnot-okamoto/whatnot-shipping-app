import {
  BASE_READONLY_CONTROL_LOGICAL_KEY,
  BASE_READONLY_TOKEN_LOGICAL_KEY,
  type BaseReadonlyOAuthControl,
} from "./base-readonly-oauth-control";
import {
  assertDevelopmentRedis,
  type DevelopmentRedisLike,
} from "./namespaced-redis";

const CLEANUP_PATTERN = "auth:base_readonly_*";
const REFRESH_LOCK_KEY = "auth:base_readonly_refresh_lock";
const STATE_PREFIX = "auth:base_readonly_state:";
const CLAIM_PREFIX = "auth:base_readonly_state_claim:";
const DRAIN_MS = 60_000;

type CleanupCategory = "token" | "refresh_lock" | "state" | "claim";

export type BaseReadonlyOAuthCleanupResult = Readonly<{
  disabledTransition: "created" | "replaced" | "already_disabled";
  deleted: Readonly<Record<CleanupCategory, number>>;
  scanCount: 2;
}>;

export class BaseReadonlyOAuthCleanupInspectionError extends Error {
  readonly code = "BASE_READONLY_OAUTH_CLEANUP_INSPECTION_FAILED";

  constructor() {
    super("Development read-only OAuth cleanup inspection failed safely.");
    this.name = "BaseReadonlyOAuthCleanupInspectionError";
  }
}

type ClassifiedKeys = {
  deleteKeys: string[];
  counts: Record<CleanupCategory, number>;
};

function classifyKeys(keys: readonly string[]): ClassifiedKeys {
  const deleteKeys: string[] = [];
  const counts: Record<CleanupCategory, number> = {
    token: 0,
    refresh_lock: 0,
    state: 0,
    claim: 0,
  };

  for (const key of keys) {
    if (key === BASE_READONLY_CONTROL_LOGICAL_KEY) continue;
    if (key === BASE_READONLY_TOKEN_LOGICAL_KEY) {
      counts.token += 1;
    } else if (key === REFRESH_LOCK_KEY) {
      counts.refresh_lock += 1;
    } else if (key.startsWith(STATE_PREFIX) && key.length > STATE_PREFIX.length) {
      counts.state += 1;
    } else if (key.startsWith(CLAIM_PREFIX) && key.length > CLAIM_PREFIX.length) {
      counts.claim += 1;
    } else {
      throw new BaseReadonlyOAuthCleanupInspectionError();
    }
    deleteKeys.push(key);
  }

  return { deleteKeys, counts };
}

async function listCandidates(redis: DevelopmentRedisLike): Promise<string[]> {
  try {
    return await redis.keys(CLEANUP_PATTERN);
  } catch {
    throw new BaseReadonlyOAuthCleanupInspectionError();
  }
}

async function verifyOnlyControlRemains(
  redis: DevelopmentRedisLike,
  control: BaseReadonlyOAuthControl
): Promise<void> {
  const remaining = await listCandidates(redis);
  if (
    remaining.some((key) => key !== BASE_READONLY_CONTROL_LOGICAL_KEY) ||
    !remaining.includes(BASE_READONLY_CONTROL_LOGICAL_KEY)
  ) {
    throw new BaseReadonlyOAuthCleanupInspectionError();
  }
  await control.assertDisabledControl();
}

export async function cleanupBaseReadonlyOAuth(input: {
  redis: DevelopmentRedisLike;
  control: BaseReadonlyOAuthControl;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<BaseReadonlyOAuthCleanupResult> {
  assertDevelopmentRedis(input.redis);
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));

  const disabledTransition = await input.control.disableForCleanup();
  await input.control.assertDisabledControl();
  await sleep(DRAIN_MS);
  await input.control.assertDisabledControl();

  const firstScan = await listCandidates(input.redis);
  const classified = classifyKeys(firstScan);

  if (classified.deleteKeys.length > 0) {
    try {
      await input.redis.del(...classified.deleteKeys);
    } catch {
      // Preserve disabled control and make one best-effort residual check.
      try {
        await verifyOnlyControlRemains(input.redis, input.control);
      } catch {
        // The public result remains a generic failure either way.
      }
      throw new BaseReadonlyOAuthCleanupInspectionError();
    }
  }

  await verifyOnlyControlRemains(input.redis, input.control);
  return {
    disabledTransition,
    deleted: Object.freeze({ ...classified.counts }),
    scanCount: 2,
  };
}

export const BASE_READONLY_CLEANUP_DRAIN_MS = DRAIN_MS;
export const BASE_READONLY_CLEANUP_LOGICAL_PATTERN = CLEANUP_PATTERN;

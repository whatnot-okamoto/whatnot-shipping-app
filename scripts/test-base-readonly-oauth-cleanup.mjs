import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseReadonlyOAuthCleanupError,
  createBaseReadonlyOAuthControl,
} from "../lib/base-readonly-oauth-control.ts";
import {
  BASE_READONLY_CLEANUP_DRAIN_MS,
  BASE_READONLY_CLEANUP_LOGICAL_PATTERN,
  BaseReadonlyOAuthCleanupInspectionError,
  cleanupBaseReadonlyOAuth,
} from "../lib/base-readonly-oauth-cleanup.ts";
import { MemoryRedis } from "../lib/memory-redis.ts";
import {
  createDevelopmentRedis,
  createProductionRedis,
  DEVELOPMENT_REDIS_NAMESPACE,
} from "../lib/namespaced-redis.ts";

const canonicalPrefix = "base-readonly-oauth:v1:";
const controlKey = "auth:base_readonly_control";
const fixedPattern = "auth:base_readonly_*";
const leaseId = Buffer.alloc(32, 7).toString("base64url");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function canonical(value) {
  return `${canonicalPrefix}${JSON.stringify(value)}`;
}

function enabledControl(expiresAt = 10_000_000) {
  return canonical({ version: 1, status: "enabled", lease_id: leaseId, expires_at: expiresAt });
}

function disabledControl(disabledAt = 1_000_000) {
  return canonical({ version: 1, status: "disabled", disabled_at: disabledAt, reason: "cleanup" });
}

class CleanupSpyRedis extends MemoryRedis {
  keyPatterns = [];
  deletedBatches = [];

  async keys(pattern) {
    this.keyPatterns.push(pattern);
    return super.keys(pattern);
  }

  async del(...keys) {
    this.deletedBatches.push([...keys]);
    return super.del(...keys);
  }
}

async function harness({ raw = new CleanupSpyRedis(), seed = "enabled" } = {}) {
  const redis = createDevelopmentRedis(raw);
  if (seed === "enabled") await redis.set(controlKey, enabledControl());
  if (seed === "disabled") await redis.set(controlKey, disabledControl());
  const control = createBaseReadonlyOAuthControl(redis, { now: () => 1_000_000 });
  return { raw, redis, control };
}

// 正常時はdisabled化、60秒drain、固定pattern 2回、既知カテゴリだけを削除する。
{
  const { raw, redis, control } = await harness();
  await redis.set("auth:base_readonly_token", "token-record");
  await redis.set("auth:base_readonly_refresh_lock", "lock-record");
  await redis.set("auth:base_readonly_state:opaque-a", "state-record");
  await redis.set("auth:base_readonly_state_claim:opaque-a", "claim-record");
  const sleeps = [];
  const result = await cleanupBaseReadonlyOAuth({
    redis,
    control,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.deepEqual(sleeps, [60_000]);
  assert.equal(BASE_READONLY_CLEANUP_DRAIN_MS, 60_000);
  assert.equal(BASE_READONLY_CLEANUP_LOGICAL_PATTERN, fixedPattern);
  assert.deepEqual(result, {
    disabledTransition: "replaced",
    deleted: { token: 1, refresh_lock: 1, state: 1, claim: 1 },
    scanCount: 2,
  });
  assert.deepEqual(raw.keyPatterns, [
    `${DEVELOPMENT_REDIS_NAMESPACE}${fixedPattern}`,
    `${DEVELOPMENT_REDIS_NAMESPACE}${fixedPattern}`,
  ]);
  assert.equal(raw.deletedBatches.length, 1);
  assert.deepEqual(
    new Set(raw.deletedBatches[0]),
    new Set([
      `${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_token`,
      `${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_refresh_lock`,
      `${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state:opaque-a`,
      `${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_state_claim:opaque-a`,
    ])
  );
  assert.equal(await redis.get("auth:base_readonly_token"), null);
  assert.equal(await redis.get(controlKey), disabledControl());
}

// control欠落は永続disabledを作成し、既存disabledは冪等維持する。
{
  const { redis, control } = await harness({ seed: "missing" });
  const result = await cleanupBaseReadonlyOAuth({ redis, control, sleep: async () => {} });
  assert.equal(result.disabledTransition, "created");
  assert.equal(await redis.get(controlKey), disabledControl());
}
{
  const { redis, control } = await harness({ seed: "disabled" });
  const result = await cleanupBaseReadonlyOAuth({ redis, control, sleep: async () => {} });
  assert.equal(result.disabledTransition, "already_disabled");
  assert.equal(await redis.get(controlKey), disabledControl());
}

// malformed／unknown controlは通常cleanupで修復せず、disabled扱いのまま明示失敗する。
{
  const { redis, control } = await harness();
  await redis.set(controlKey, "malformed-control");
  await assert.rejects(
    cleanupBaseReadonlyOAuth({ redis, control, sleep: async () => {} }),
    BaseReadonlyOAuthCleanupError
  );
  assert.equal(await redis.get(controlKey), "malformed-control");
}
{
  const { redis, control } = await harness();
  await redis.set(
    controlKey,
    canonical({ version: 99, status: "disabled", disabled_at: 1, reason: "cleanup" })
  );
  await assert.rejects(
    cleanupBaseReadonlyOAuth({ redis, control, sleep: async () => {} }),
    BaseReadonlyOAuthCleanupError
  );
}

// 未知キーは1回目の固定pattern列挙で停止し、削除を一切行わない。
{
  const { raw, redis, control } = await harness();
  await redis.set("auth:base_readonly_future:opaque-secret", "unknown-record");
  await assert.rejects(
    cleanupBaseReadonlyOAuth({ redis, control, sleep: async () => {} }),
    (error) => {
      assert.ok(error instanceof BaseReadonlyOAuthCleanupInspectionError);
      assert.equal(error.message.includes("opaque-secret"), false);
      return true;
    }
  );
  assert.equal(raw.keyPatterns.length, 1);
  assert.equal(raw.deletedBatches.length, 0);
  assert.equal(await redis.get("auth:base_readonly_future:opaque-secret"), "unknown-record");
  assert.equal(await redis.get(controlKey), disabledControl());
}

// 削除失敗はcontrolを維持し、結果を成功扱いしない。
{
  class FailingDeleteRedis extends CleanupSpyRedis {
    async del(...keys) {
      this.deletedBatches.push([...keys]);
      throw new Error("backend key and value must not escape");
    }
  }
  const { raw, redis, control } = await harness({ raw: new FailingDeleteRedis() });
  await redis.set("auth:base_readonly_token", "token-record");
  await assert.rejects(
    cleanupBaseReadonlyOAuth({ redis, control, sleep: async () => {} }),
    (error) => {
      assert.ok(error instanceof BaseReadonlyOAuthCleanupInspectionError);
      assert.equal(error.message.includes("backend"), false);
      assert.equal(error.message.includes("token-record"), false);
      return true;
    }
  );
  assert.equal(raw.keyPatterns.length, 2);
  assert.equal(await redis.get(controlKey), disabledControl());
}

// Production adapterはcleanupへ渡せず、Productionキーへ到達しない。
{
  const raw = new CleanupSpyRedis();
  const production = createProductionRedis(raw);
  const fakeControl = {};
  await assert.rejects(
    cleanupBaseReadonlyOAuth({ redis: production, control: fakeControl, sleep: async () => {} }),
    /namespaced Development Redis adapter/
  );
  assert.deepEqual(raw.keyPatterns, []);
  assert.deepEqual(raw.deletedBatches, []);
}

// callerはpattern、drain、削除カテゴリを変更できず、CLIは非HTTP・明示確認制。
const cleanupSource = await readFile(
  path.join(repositoryRoot, "lib/base-readonly-oauth-cleanup.ts"),
  "utf8"
);
const cliSource = await readFile(
  path.join(repositoryRoot, "scripts/cleanup-base-readonly-oauth.mjs"),
  "utf8"
);
assert.equal(cleanupSource.includes("input.pattern"), false);
assert.equal(cleanupSource.includes("input.drain"), false);
assert.ok(cleanupSource.includes('const CLEANUP_PATTERN = "auth:base_readonly_*"'));
assert.ok(cliSource.includes("--confirm-disabled-cleanup"));
assert.equal(cliSource.includes("fetch("), false);
assert.equal(cliSource.includes("createEnabled"), false);
assert.equal(cliSource.includes("diagnostic"), false);

console.log("base readonly OAuth cleanup contract tests passed");

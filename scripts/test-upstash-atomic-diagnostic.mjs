import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRedis } from "../lib/memory-redis.ts";
import {
  createDevelopmentRedis,
  createProductionRedis,
  DEVELOPMENT_REDIS_NAMESPACE,
} from "../lib/namespaced-redis.ts";
import {
  UPSTASH_ATOMIC_DIAGNOSTIC_DUMMY_VALUES,
  UPSTASH_ATOMIC_DIAGNOSTIC_G1,
  UPSTASH_ATOMIC_DIAGNOSTIC_G1_ORDER_DIFFERENT,
  UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY,
  UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_TTL_SECONDS,
  UPSTASH_ATOMIC_DIAGNOSTIC_T2,
  UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY,
} from "../lib/upstash-atomic-contract.ts";
import { runUpstashAtomicDiagnostic } from "../lib/upstash-atomic-diagnostic.ts";
import { runUpstashAtomicRecovery } from "../lib/upstash-atomic-recovery.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const physicalGuard = `${DEVELOPMENT_REDIS_NAMESPACE}${UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY}`;
const physicalTarget = `${DEVELOPMENT_REDIS_NAMESPACE}${UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY}`;
const allowedPhysicalKeys = new Set([physicalGuard, physicalTarget]);

class RecordingRedis extends MemoryRedis {
  calls = [];
  failAtCall = null;
  failure = null;

  record(operation, args) {
    this.calls.push([operation, ...args]);
    if (this.failAtCall === this.calls.length) {
      throw this.failure ?? new Error("fixed test failure");
    }
  }

  async get(key) {
    this.record("get", [key]);
    return super.get(key);
  }

  async set(key, value, options) {
    this.record("set", [key, value, options]);
    return super.set(key, value, options);
  }

  async compareAndDelete(key, expectedValue) {
    this.record("compareAndDelete", [key, expectedValue]);
    return super.compareAndDelete(key, expectedValue);
  }

  async setIfValueMatches(guardKey, expectedGuardValue, targetKey, value) {
    this.record("setIfValueMatches", [
      guardKey,
      expectedGuardValue,
      targetKey,
      value,
    ]);
    return super.setIfValueMatches(
      guardKey,
      expectedGuardValue,
      targetKey,
      value
    );
  }

  async keys(pattern) {
    this.record("keys", [pattern]);
    return super.keys(pattern);
  }
}

function assertOnlyFixedPhysicalKeys(calls) {
  for (const [operation, ...args] of calls) {
    if (operation === "get" || operation === "set" || operation === "compareAndDelete") {
      assert.ok(allowedPhysicalKeys.has(args[0]), `${operation} used an unexpected key`);
    }
    if (operation === "setIfValueMatches") {
      assert.ok(allowedPhysicalKeys.has(args[0]), "fenced write used an unexpected guard");
      assert.ok(allowedPhysicalKeys.has(args[2]), "fenced write used an unexpected target");
    }
    assert.notEqual(operation, "keys");
  }
  const serialized = JSON.stringify(calls);
  assert.equal(serialized.includes("auth:base_readonly_"), false);
  assert.equal(serialized.includes("{v1}"), false);
}

// The successful local contract follows the fixed 13-step sequence and
// leaves only the two fixed dev:v1: physical keys absent.
{
  const raw = new RecordingRedis();
  const redis = createDevelopmentRedis(raw);
  assert.equal(await runUpstashAtomicDiagnostic(redis), "PASS_ATOMIC_CONTRACT");
  assert.deepEqual(
    raw.calls.map(([operation]) => operation),
    [
      "get",
      "get",
      "set",
      "setIfValueMatches",
      "get",
      "setIfValueMatches",
      "get",
      "compareAndDelete",
      "get",
      "compareAndDelete",
      "compareAndDelete",
      "compareAndDelete",
      "setIfValueMatches",
      "get",
      "get",
    ]
  );
  assert.deepEqual(raw.calls[2], [
    "set",
    physicalGuard,
    UPSTASH_ATOMIC_DIAGNOSTIC_G1,
    { nx: true, ex: 600 },
  ]);
  assert.deepEqual(raw.calls[3], [
    "setIfValueMatches",
    physicalGuard,
    UPSTASH_ATOMIC_DIAGNOSTIC_G1_ORDER_DIFFERENT,
    physicalTarget,
    UPSTASH_ATOMIC_DIAGNOSTIC_T2,
  ]);
  assertOnlyFixedPhysicalKeys(raw.calls);
  assert.equal(await MemoryRedis.prototype.get.call(raw, physicalGuard), null);
  assert.equal(await MemoryRedis.prototype.get.call(raw, physicalTarget), null);
}

assert.equal(UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_TTL_SECONDS, 600);
assert.equal(UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY.includes("{"), false);
assert.equal(UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY.includes("}"), false);
assert.equal(UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY.includes("{"), false);
assert.equal(UPSTASH_ATOMIC_DIAGNOSTIC_TARGET_KEY.includes("}"), false);
assert.equal(UPSTASH_ATOMIC_DIAGNOSTIC_DUMMY_VALUES.length, 4);

// Existing diagnostic keys stop before any write or delete.
{
  const raw = new RecordingRedis();
  await MemoryRedis.prototype.set.call(raw, physicalGuard, UPSTASH_ATOMIC_DIAGNOSTIC_G1);
  raw.calls = [];
  const redis = createDevelopmentRedis(raw);
  assert.equal(
    await runUpstashAtomicDiagnostic(redis),
    "STOP_DIAGNOSTIC_KEYS_PRESENT"
  );
  assert.deepEqual(raw.calls.map(([operation]) => operation), ["get", "get"]);
}

// A guard that appears after the initial reads is a diagnostic-key race, not
// a contract mismatch. Stop immediately after GET, GET, SET NX.
{
  class RacingGuardRedis extends RecordingRedis {
    async set(key, value, options) {
      this.record("set", [key, value, options]);
      return null;
    }
  }
  const raw = new RacingGuardRedis();
  const redis = createDevelopmentRedis(raw);
  assert.equal(
    await runUpstashAtomicDiagnostic(redis),
    "STOP_DIAGNOSTIC_KEYS_PRESENT"
  );
  assert.deepEqual(raw.calls.map(([operation]) => operation), [
    "get",
    "get",
    "set",
  ]);
}

// A confirmed unexpected boolean stops as a contract mismatch.
{
  class MismatchedBooleanRedis extends RecordingRedis {
    async setIfValueMatches(guardKey, expectedGuardValue, targetKey, value) {
      this.record("setIfValueMatches", [
        guardKey,
        expectedGuardValue,
        targetKey,
        value,
      ]);
      return true;
    }
  }
  const raw = new MismatchedBooleanRedis();
  const redis = createDevelopmentRedis(raw);
  assert.equal(
    await runUpstashAtomicDiagnostic(redis),
    "STOP_CONTRACT_MISMATCH"
  );
  assert.deepEqual(raw.calls.map(([operation]) => operation), [
    "get",
    "get",
    "set",
    "setIfValueMatches",
  ]);
}

// Throw and timeout are both indeterminate, and no operation follows the
// failing request in the same process.
for (const failure of [
  new Error("raw backend value must not escape"),
  Object.assign(new Error("request timed out with secret detail"), {
    name: "TimeoutError",
  }),
]) {
  const raw = new RecordingRedis();
  raw.failAtCall = 4;
  raw.failure = failure;
  const redis = createDevelopmentRedis(raw);
  const result = await runUpstashAtomicDiagnostic(redis);
  assert.equal(result, "STOP_ATOMIC_INDETERMINATE");
  assert.equal(result.includes(failure.message), false);
  assert.equal(raw.calls.length, 4);
}

// Raw and Production adapters are rejected before any Redis operation.
{
  const raw = new RecordingRedis();
  assert.equal(await runUpstashAtomicDiagnostic(raw), "STOP_RUNTIME_BOUNDARY");
  assert.equal(await runUpstashAtomicRecovery(raw), "STOP_RUNTIME_BOUNDARY");
  assert.deepEqual(raw.calls, []);

  const productionRaw = new RecordingRedis();
  const production = createProductionRedis(productionRaw);
  assert.equal(
    await runUpstashAtomicDiagnostic(production),
    "STOP_RUNTIME_BOUNDARY"
  );
  assert.equal(
    await runUpstashAtomicRecovery(production),
    "STOP_RUNTIME_BOUNDARY"
  );
  assert.deepEqual(productionRaw.calls, []);
}

// Recovery reads only the two fixed keys, accepts only fixed dummy values,
// and deletes each present value through exact compare-and-delete.
{
  const raw = new RecordingRedis();
  await MemoryRedis.prototype.set.call(raw, physicalGuard, UPSTASH_ATOMIC_DIAGNOSTIC_G1);
  await MemoryRedis.prototype.set.call(raw, physicalTarget, UPSTASH_ATOMIC_DIAGNOSTIC_T2);
  raw.calls = [];
  const redis = createDevelopmentRedis(raw);
  assert.equal(await runUpstashAtomicRecovery(redis), "PASS_RECOVERY_COMPLETE");
  assert.deepEqual(raw.calls.map(([operation]) => operation), [
    "get",
    "get",
    "compareAndDelete",
    "compareAndDelete",
    "get",
    "get",
  ]);
  assertOnlyFixedPhysicalKeys(raw.calls);
}
{
  const raw = new RecordingRedis();
  const redis = createDevelopmentRedis(raw);
  assert.equal(await runUpstashAtomicRecovery(redis), "PASS_RECOVERY_COMPLETE");
  assert.deepEqual(raw.calls.map(([operation]) => operation), [
    "get",
    "get",
    "get",
    "get",
  ]);
}
{
  const raw = new RecordingRedis();
  await MemoryRedis.prototype.set.call(raw, physicalGuard, "fixed-unexpected-value");
  raw.calls = [];
  const redis = createDevelopmentRedis(raw);
  assert.equal(
    await runUpstashAtomicRecovery(redis),
    "STOP_RECOVERY_VALUE_UNEXPECTED"
  );
  assert.deepEqual(raw.calls.map(([operation]) => operation), ["get", "get"]);
}

for (const failure of [
  new Error("raw recovery detail must not escape"),
  Object.assign(new Error("recovery timeout with secret detail"), {
    name: "TimeoutError",
  }),
]) {
  const raw = new RecordingRedis();
  await MemoryRedis.prototype.set.call(raw, physicalGuard, UPSTASH_ATOMIC_DIAGNOSTIC_G1);
  raw.calls = [];
  raw.failAtCall = 3;
  raw.failure = failure;
  const redis = createDevelopmentRedis(raw);
  const result = await runUpstashAtomicRecovery(redis);
  assert.equal(result, "STOP_RECOVERY_INDETERMINATE");
  assert.equal(result.includes(failure.message), false);
  assert.equal(raw.calls.length, 3);
}

// The public runners accept only a Redis boundary; key/value/timeout/pattern
// are fixed module constants rather than caller inputs.
assert.equal(runUpstashAtomicDiagnostic.length, 1);
assert.equal(runUpstashAtomicRecovery.length, 1);

const source = async (relativePath) =>
  readFile(path.join(repositoryRoot, relativePath), "utf8");
const upstashSource = await source("lib/upstash.ts");
const diagnosticSource = await source("lib/upstash-atomic-diagnostic.ts");
const recoverySource = await source("lib/upstash-atomic-recovery.ts");
const diagnosticCliSource = await source("scripts/diagnose-upstash-atomic.mjs");
const recoveryCliSource = await source("scripts/recover-upstash-atomic.mjs");

const normalFactorySource = upstashSource.slice(
  upstashSource.indexOf("function createRedisClient"),
  upstashSource.indexOf("export const redis")
);
assert.equal(normalFactorySource.includes("retry:"), false);
assert.equal(normalFactorySource.includes("signal:"), false);
assert.match(
  upstashSource,
  /createDevelopmentAtomicVerificationRedis\(\)[\s\S]*retry: \{ retries: 0 \}[\s\S]*AbortSignal\.timeout\(DEVELOPMENT_ATOMIC_REQUEST_TIMEOUT_MS\)/
);
assert.equal(upstashSource.includes("export class UpstashRedisAdapter"), false);
assert.equal(upstashSource.includes("export const rawClient"), false);

for (const moduleSource of [diagnosticSource, recoverySource]) {
  assert.equal(moduleSource.includes(".keys("), false);
  assert.equal(moduleSource.toLowerCase().includes("scan("), false);
  assert.equal(moduleSource.includes("auth:base_readonly_control"), false);
  assert.equal(moduleSource.includes("auth:base_readonly_token"), false);
  assert.equal(moduleSource.includes("console."), false);
}
assert.equal(diagnosticCliSource.includes("recover-upstash-atomic"), false);
assert.equal(diagnosticCliSource.includes("runUpstashAtomicRecovery"), false);
assert.equal(recoveryCliSource.includes("runUpstashAtomicDiagnostic"), false);
for (const cliSource of [diagnosticCliSource, recoveryCliSource]) {
  assert.equal(cliSource.includes("console."), false);
  assert.equal(cliSource.includes("process.stderr"), false);
  assert.equal(cliSource.includes(".message"), false);
}
for (const [classification, exitCode] of [
  ["PASS_ATOMIC_CONTRACT", 0],
  ["STOP_DIAGNOSTIC_KEYS_PRESENT", 10],
  ["STOP_CONTRACT_MISMATCH", 11],
  ["STOP_ATOMIC_INDETERMINATE", 12],
  ["STOP_RUNTIME_BOUNDARY", 13],
]) {
  assert.ok(diagnosticCliSource.includes(`${classification}: ${exitCode}`));
}
for (const [classification, exitCode] of [
  ["PASS_RECOVERY_COMPLETE", 0],
  ["STOP_RECOVERY_VALUE_UNEXPECTED", 20],
  ["STOP_RECOVERY_INDETERMINATE", 21],
  ["STOP_RUNTIME_BOUNDARY", 13],
]) {
  assert.ok(recoveryCliSource.includes(`${classification}: ${exitCode}`));
}

// Execute both CLIs in a sanitized local/mock/memory identity. The dedicated
// factory must stop before creating an external client and emit only a fixed
// classification and exit code.
function runBoundaryCli(script, confirmation) {
  const env = {
    APP_ENVIRONMENT: "local",
    BASE_DATA_MODE: "mock",
    APP_STORE_MODE: "memory",
    NODE_NO_WARNINGS: "1",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
  };
  return spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      "--experimental-loader",
      "./scripts/upstash-atomic-cli-loader.mjs",
      script,
      confirmation,
    ],
    {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 10_000,
    }
  );
}

const diagnosticBoundary = runBoundaryCli(
  "scripts/diagnose-upstash-atomic.mjs",
  "--confirm-fixed-diagnostic"
);
assert.equal(diagnosticBoundary.error, undefined);
assert.equal(diagnosticBoundary.status, 13);
assert.equal(diagnosticBoundary.stdout, "STOP_RUNTIME_BOUNDARY\n");
assert.equal(diagnosticBoundary.stderr, "");

const recoveryBoundary = runBoundaryCli(
  "scripts/recover-upstash-atomic.mjs",
  "--confirm-fixed-recovery"
);
assert.equal(recoveryBoundary.error, undefined);
assert.equal(recoveryBoundary.status, 13);
assert.equal(recoveryBoundary.stdout, "STOP_RUNTIME_BOUNDARY\n");
assert.equal(recoveryBoundary.stderr, "");

console.log("Upstash atomic diagnostic and recovery contract tests passed");

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
import { UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY } from "../lib/upstash-atomic-contract.ts";
import { runUpstashAtomicReadOnlyBoundary } from "../lib/upstash-atomic-readonly.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const dummyUrl = "https://nonsecret-readonly.invalid";
const dummyToken = "nonsecret-readonly-token";
const rawSentinel = "RAW_READONLY_DETAIL_MUST_NOT_SURFACE";
const physicalGuard = `${DEVELOPMENT_REDIS_NAMESPACE}${UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY}`;

// The dedicated test process discards inherited names without reading values.
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, {
  APP_ENVIRONMENT: "development",
  BASE_DATA_MODE: "readonly",
  APP_STORE_MODE: "upstash",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "codex/development",
  UPSTASH_REDIS_REST_URL: dummyUrl,
  UPSTASH_REDIS_REST_TOKEN: dummyToken,
});

const UPSTASH_PACKAGE = ["@", "upstash", "/redis"].join("");
const { Redis } = await import(UPSTASH_PACKAGE);
const { createDevelopmentAtomicVerificationRedis } = await import(
  "../lib/upstash.ts"
);

function structuredTransportError(code = "ECONNREFUSED") {
  return new TypeError(rawSentinel, { cause: { code } });
}

async function countFetches(retry) {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw structuredTransportError();
  };
  try {
    const redis = new Redis({
      url: dummyUrl,
      token: dummyToken,
      retry,
      signal: () => AbortSignal.timeout(10_000),
    });
    await assert.rejects(redis.get("nonsecret:retry-fixture"));
    return fetchCalls;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Installed SDK 1.37.0 retries once for retry:false, while retries:0 is
// exactly one fetch for a retryable failure.
assert.equal(await countFetches(false), 2);
assert.equal(await countFetches({ retries: 0 }), 1);

class ReadOnlyRecordingRedis extends MemoryRedis {
  calls = [];

  async get(key) {
    this.calls.push(["get", key]);
    return super.get(key);
  }

  async set(...args) {
    this.calls.push(["set", ...args]);
    return super.set(...args);
  }

  async del(...keys) {
    this.calls.push(["del", ...keys]);
    return super.del(...keys);
  }

  async sadd(key, ...members) {
    this.calls.push(["sadd", key, ...members]);
    return super.sadd(key, ...members);
  }

  async srem(key, ...members) {
    this.calls.push(["srem", key, ...members]);
    return super.srem(key, ...members);
  }

  async smembers(key) {
    this.calls.push(["smembers", key]);
    return super.smembers(key);
  }

  async compareAndDelete(...args) {
    this.calls.push(["compareAndDelete", ...args]);
    return super.compareAndDelete(...args);
  }

  async setIfValueMatches(...args) {
    this.calls.push(["setIfValueMatches", ...args]);
    return super.setIfValueMatches(...args);
  }

  async keys(pattern) {
    this.calls.push(["keys", pattern]);
    return super.keys(pattern);
  }

  pipeline() {
    this.calls.push(["pipeline"]);
    return super.pipeline();
  }
}

// The public runner accepts only a namespaced Redis boundary and performs one
// GET against the fixed diagnostic guard. The returned value is discarded.
{
  const raw = new ReadOnlyRecordingRedis();
  await MemoryRedis.prototype.set.call(raw, physicalGuard, rawSentinel);
  raw.calls = [];
  const redis = createDevelopmentRedis(raw);
  assert.equal(
    await runUpstashAtomicReadOnlyBoundary(redis),
    "PASS_READONLY_BOUNDARY"
  );
  assert.deepEqual(raw.calls, [["get", physicalGuard]]);
  assert.equal(JSON.stringify(raw.calls).includes("auth:base_readonly_"), false);
  assert.equal(JSON.stringify(raw.calls).includes("auth:base_token"), false);
}

// Raw and Production adapters stop before all Redis operations.
for (const candidate of [
  new ReadOnlyRecordingRedis(),
  createProductionRedis(new ReadOnlyRecordingRedis()),
]) {
  assert.equal(
    await runUpstashAtomicReadOnlyBoundary(candidate),
    "STOP_RUNTIME_BOUNDARY"
  );
}
assert.equal(runUpstashAtomicReadOnlyBoundary.length, 1);

async function runSdkScenario(fetchImpl) {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    return fetchImpl(...args);
  };
  try {
    const redis = createDevelopmentAtomicVerificationRedis();
    const classification = await runUpstashAtomicReadOnlyBoundary(redis);
    assert.equal(classification.includes(rawSentinel), false);
    return { classification, fetchCalls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const result = await runSdkScenario(async () =>
    new Response(JSON.stringify([{ result: "bnVsbA==" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  assert.deepEqual(result, {
    classification: "PASS_READONLY_BOUNDARY",
    fetchCalls: 1,
  });
}

for (const status of [401, 403]) {
  const result = await runSdkScenario(async () =>
    new Response(rawSentinel, { status })
  );
  assert.deepEqual(result, {
    classification: "STOP_READONLY_AUTH",
    fetchCalls: 1,
  });
}

{
  const result = await runSdkScenario(async () => {
    throw structuredTransportError("ENOTFOUND");
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_TRANSPORT",
    fetchCalls: 1,
  });
}

for (const code of [
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]) {
  const result = await runSdkScenario(async () => {
    throw structuredTransportError(code);
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_TIMEOUT",
    fetchCalls: 1,
  });
}

{
  const result = await runSdkScenario(async () => {
    throw new Error(rawSentinel);
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_INDETERMINATE",
    fetchCalls: 1,
  });
}

// Test-only shortening exercises the real fixed AbortSignal path without
// changing the production 10-second constant or exposing a caller option.
{
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => originalTimeout(25);
  const keepEventLoopAlive = setTimeout(() => {}, 1_000);
  try {
    const result = await runSdkScenario(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error(rawSentinel));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        })
    );
    assert.deepEqual(result, {
      classification: "STOP_READONLY_TIMEOUT",
      fetchCalls: 1,
    });
  } finally {
    clearTimeout(keepEventLoopAlive);
    AbortSignal.timeout = originalTimeout;
  }
}

const readOnlySource = await readFile(
  path.join(repositoryRoot, "lib", "upstash-atomic-readonly.ts"),
  "utf8"
);
const cliSource = await readFile(
  path.join(repositoryRoot, "scripts", "probe-upstash-atomic-readonly.mjs"),
  "utf8"
);
for (const forbidden of [
  ".set(",
  ".del(",
  ".eval(",
  ".pipeline(",
  ".keys(",
  ".scan(",
  "auth:base_readonly_",
  "auth:base_token",
  "process.stderr",
  ".message",
]) {
  assert.equal(readOnlySource.includes(forbidden), false);
  assert.equal(cliSource.includes(forbidden), false);
}
assert.equal(cliSource.includes("diagnose-upstash-atomic"), false);
assert.equal(cliSource.includes("recover-upstash-atomic"), false);

// A sanitized non-Development child stops before client construction and
// emits only the fixed runtime classification.
{
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      "--experimental-loader",
      "./scripts/upstash-atomic-cli-loader.mjs",
      "./scripts/probe-upstash-atomic-readonly.mjs",
      "--confirm-fixed-readonly",
    ],
    {
      cwd: repositoryRoot,
      env: {
        APP_ENVIRONMENT: "local",
        BASE_DATA_MODE: "mock",
        APP_STORE_MODE: "memory",
      },
      encoding: "utf8",
      timeout: 10_000,
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 13);
  assert.equal(result.stdout, "STOP_RUNTIME_BOUNDARY\n");
  assert.equal(result.stderr, "");
}

process.stdout.write("Upstash atomic read-only boundary tests passed\n");

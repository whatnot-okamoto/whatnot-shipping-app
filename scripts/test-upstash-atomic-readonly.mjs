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

function errorWithOwnCode(code) {
  const error = new Error(rawSentinel);
  Object.defineProperty(error, "code", { value: code, configurable: true });
  return error;
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
    "STOP_READONLY_BEFORE_FETCH"
  );
}
assert.equal(runUpstashAtomicReadOnlyBoundary.length, 1);

// A valid Development boundary that fails before invoking fetch is classified
// separately and does not cause a later Redis operation.
{
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error(rawSentinel);
  };
  try {
    const raw = new ReadOnlyRecordingRedis();
    raw.get = async function get(key) {
      this.calls.push(["get", key]);
      throw new Error(rawSentinel);
    };
    const redis = createDevelopmentRedis(raw);
    assert.equal(
      await runUpstashAtomicReadOnlyBoundary(redis),
      "STOP_READONLY_BEFORE_FETCH"
    );
    assert.equal(fetchCalls, 0);
    assert.deepEqual(raw.calls, [["get", physicalGuard]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runSdkScenario(fetchImpl) {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  const countingFetch = async (...args) => {
    fetchCalls += 1;
    return fetchImpl(...args);
  };
  globalThis.fetch = countingFetch;
  try {
    const redis = createDevelopmentAtomicVerificationRedis();
    const classification = await runUpstashAtomicReadOnlyBoundary(redis);
    assert.equal(globalThis.fetch, countingFetch);
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

for (const status of [400, 404, 500]) {
  const result = await runSdkScenario(async () =>
    new Response(rawSentinel, { status })
  );
  assert.deepEqual(result, {
    classification: "STOP_READONLY_HTTP",
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

// A source-confirmed request-construction code is a local request stop after
// the JavaScript fetch invocation, not a transport failure.
{
  const result = await runSdkScenario(async () => {
    throw structuredTransportError("ERR_INVALID_URL");
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_LOCAL_REQUEST",
    fetchCalls: 1,
  });
}

// The fixed extractor covers direct, cause, bounded aggregate, and nested
// cause own-data-property layouts without changing the public request count.
for (const error of [
  errorWithOwnCode("ETIMEDOUT"),
  new TypeError(rawSentinel, {
    cause: new AggregateError([errorWithOwnCode("ETIMEDOUT")]),
  }),
]) {
  const result = await runSdkScenario(async () => {
    throw error;
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_TIMEOUT",
    fetchCalls: 1,
  });
}

{
  const result = await runSdkScenario(async () => {
    throw new TypeError(rawSentinel, {
      cause: new Error(rawSentinel, {
        cause: errorWithOwnCode("ENOTFOUND"),
      }),
    });
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_TRANSPORT",
    fetchCalls: 1,
  });
}

// NodeAggregateError exposes the first code directly and retains the standard
// AggregateError errors array. The equivalent public shape stays stable when
// every observed code belongs to one known family.
{
  const aggregate = new AggregateError([
    errorWithOwnCode("ETIMEDOUT"),
    errorWithOwnCode("UND_ERR_CONNECT_TIMEOUT"),
  ]);
  Object.defineProperty(aggregate, "code", { value: "ETIMEDOUT" });
  const result = await runSdkScenario(async () => {
    throw new TypeError(rawSentinel, { cause: aggregate });
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_TIMEOUT",
    fetchCalls: 1,
  });
}

for (const code of [
  "ERR_INVALID_URL",
  "ERR_INVALID_URL_SCHEME",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_THIS",
  "UND_ERR_INVALID_ARG",
  "UND_ERR_INVALID_RETURN_VALUE",
  "UND_ERR_NOT_SUPPORTED",
  "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
]) {
  const result = await runSdkScenario(async () => {
    throw new TypeError(rawSentinel, { cause: errorWithOwnCode(code) });
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_LOCAL_REQUEST",
    fetchCalls: 1,
  });
  assert.equal(result.classification.includes(code), false);
}

for (const error of [
  new TypeError(rawSentinel, {
    cause: new AggregateError([
      errorWithOwnCode("ETIMEDOUT"),
      errorWithOwnCode("ENOTFOUND"),
      errorWithOwnCode("ERR_INVALID_URL"),
    ]),
  }),
  new TypeError(rawSentinel, {
    cause: new AggregateError([
      errorWithOwnCode("ETIMEDOUT"),
      errorWithOwnCode("FIXED_UNKNOWN_CODE"),
    ]),
  }),
  new TypeError(rawSentinel, {
    cause: errorWithOwnCode("FIXED_UNKNOWN_CODE"),
  }),
  new TypeError(rawSentinel, {
    cause: errorWithOwnCode("ERR_TLS_NOT_SOURCE_CONFIRMED"),
  }),
  new Error(rawSentinel),
]) {
  const result = await runSdkScenario(async () => {
    throw error;
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_INDETERMINATE",
    fetchCalls: 1,
  });
  assert.equal(result.classification.includes("FIXED_UNKNOWN_CODE"), false);
}

// Accessor descriptors are never invoked. Their presence makes the bounded
// structural result indeterminate even when another known code is present.
for (const property of ["code", "cause", "errors"]) {
  let getterCalls = 0;
  const error = errorWithOwnCode("ETIMEDOUT");
  Object.defineProperty(error, property, {
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error(rawSentinel);
    },
  });
  const result = await runSdkScenario(async () => {
    throw error;
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_INDETERMINATE",
    fetchCalls: 1,
  });
  assert.equal(getterCalls, 0);
}

{
  let indexGetterCalls = 0;
  const members = [];
  Object.defineProperty(members, "0", {
    get() {
      indexGetterCalls += 1;
      throw new Error(rawSentinel);
    },
  });
  Object.defineProperty(members, "length", { value: 1 });
  const error = new Error(rawSentinel);
  Object.defineProperty(error, "errors", { value: members });
  const result = await runSdkScenario(async () => {
    throw error;
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_INDETERMINATE",
    fetchCalls: 1,
  });
  assert.equal(indexGetterCalls, 0);
}

// Descriptor failure, cycles, and every fixed traversal limit fail closed.
{
  const descriptorFailure = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error(rawSentinel);
      },
    }
  );
  const result = await runSdkScenario(async () => {
    throw descriptorFailure;
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_INDETERMINATE",
    fetchCalls: 1,
  });
}

{
  const cyclic = errorWithOwnCode("ETIMEDOUT");
  Object.defineProperty(cyclic, "cause", { value: cyclic });
  const result = await runSdkScenario(async () => {
    throw cyclic;
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_INDETERMINATE",
    fetchCalls: 1,
  });
}

{
  let tooDeep = errorWithOwnCode("ETIMEDOUT");
  for (let index = 0; index < 5; index += 1) {
    tooDeep = new Error(rawSentinel, { cause: tooDeep });
  }
  const result = await runSdkScenario(async () => {
    throw tooDeep;
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_INDETERMINATE",
    fetchCalls: 1,
  });
}

{
  const tooManyAggregateMembers = new AggregateError(
    Array.from({ length: 9 }, () => errorWithOwnCode("ETIMEDOUT"))
  );
  const result = await runSdkScenario(async () => {
    throw tooManyAggregateMembers;
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_INDETERMINATE",
    fetchCalls: 1,
  });
}

{
  const tooManyObjects = new AggregateError(
    Array.from(
      { length: 8 },
      () =>
        new AggregateError(
          Array.from({ length: 4 }, () => errorWithOwnCode("ETIMEDOUT"))
        )
    )
  );
  const result = await runSdkScenario(async () => {
    throw tooManyObjects;
  });
  assert.deepEqual(result, {
    classification: "STOP_READONLY_INDETERMINATE",
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

// A fetch resolution that is not a native Response remains an intentionally
// unclassified post-fetch/pre-Response residual.
{
  const result = await runSdkScenario(async () => ({ ok: true }));
  assert.deepEqual(result, {
    classification: "STOP_READONLY_INDETERMINATE",
    fetchCalls: 1,
  });
}

// A successful HTTP Response that the real SDK cannot parse is a response
// processing stop, not a transport or pre-response failure.
{
  const result = await runSdkScenario(async () =>
    new Response(rawSentinel, {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  assert.deepEqual(result, {
    classification: "STOP_READONLY_RESPONSE_PROCESSING",
    fetchCalls: 1,
  });
}


// Body-read and decoded-result failures occur after a successful Response and
// are independently fixed to the response-processing stop.
for (const fetchImpl of [
  async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error(rawSentinel));
        },
      }),
      { status: 200 }
    ),
  async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  async () =>
    new Response(JSON.stringify([{ error: rawSentinel }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
]) {
  const result = await runSdkScenario(fetchImpl);
  assert.deepEqual(result, {
    classification: "STOP_READONLY_RESPONSE_PROCESSING",
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
  "error.cause",
  "error.code",
  "error.errors",
]) {
  assert.equal(readOnlySource.includes(forbidden), false);
  assert.equal(cliSource.includes(forbidden), false);
}
assert.ok(readOnlySource.includes("Object.getOwnPropertyDescriptor"));
assert.ok(readOnlySource.includes("MAX_ERROR_TRAVERSAL_DEPTH = 3"));
assert.ok(readOnlySource.includes("MAX_AGGREGATE_ERROR_COUNT = 8"));
assert.ok(readOnlySource.includes("MAX_INSPECTED_ERROR_OBJECTS = 32"));
assert.equal(readOnlySource.includes("STOP_READONLY_STRUCTURED_UNKNOWN"), false);
assert.equal(cliSource.includes("STOP_READONLY_STRUCTURED_UNKNOWN"), false);
assert.equal(cliSource.includes("diagnose-upstash-atomic"), false);
assert.equal(cliSource.includes("recover-upstash-atomic"), false);
assert.equal(cliSource.includes("STOP_READONLY_WRAPPER_INDETERMINATE"), false);
assert.equal(cliSource.includes("STOP_RUNTIME_BOUNDARY"), false);

// A sanitized non-Development child starts successfully but stops before
// fetch, emitting only the fixed child classification.
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
  assert.equal(result.status, 35);
  assert.equal(result.stdout, "STOP_READONLY_BEFORE_FETCH\n");
  assert.equal(result.stderr, "");
}

// A directly started child with an invalid fixed confirmation argument also
// classifies inside the child before fetch; the PowerShell launcher itself
// never supplies this shape.
{
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      "--experimental-loader",
      "./scripts/upstash-atomic-cli-loader.mjs",
      "./scripts/probe-upstash-atomic-readonly.mjs",
    ],
    {
      cwd: repositoryRoot,
      env: {},
      encoding: "utf8",
      timeout: 10_000,
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 35);
  assert.equal(result.stdout, "STOP_READONLY_BEFORE_FETCH\n");
  assert.equal(result.stderr, "");
}

process.stdout.write("Upstash atomic read-only boundary tests passed\n");

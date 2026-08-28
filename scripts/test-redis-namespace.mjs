import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRedis } from "../lib/memory-redis.ts";
import {
  createDevelopmentRedis,
  createProductionRedis,
  DEVELOPMENT_REDIS_NAMESPACE,
} from "../lib/namespaced-redis.ts";
import {
  assertProductionRuntime,
  resolveRuntimeConfig,
} from "../lib/runtime-mode.ts";

const raw = new MemoryRedis();
const development = createDevelopmentRedis(raw);

assert.equal(await development.set("order:1", { id: 1 }), "OK");
assert.deepEqual(await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}order:1`), {
  id: 1,
});
assert.deepEqual(await development.get("order:1"), { id: 1 });
assert.equal(await development.sadd("index:orders", "1", "2"), 2);
assert.deepEqual((await development.smembers("index:orders")).sort(), ["1", "2"]);
assert.equal(await development.srem("index:orders", "1"), 1);
assert.equal(await development.del("order:1"), 1);

await development.set("order:2", "two");
await development.set("order:3", "three");
assert.deepEqual((await development.keys("order:*")).sort(), ["order:2", "order:3"]);

const pipeline = development.pipeline();
pipeline.set("pipeline:value", "ok");
pipeline.get("pipeline:value");
pipeline.sadd("pipeline:set", "x", "y");
pipeline.srem("pipeline:set", "x");
pipeline.del("pipeline:value");
assert.deepEqual(await pipeline.exec(), ["OK", "ok", 2, 1, 1]);
assert.deepEqual(await raw.smembers(`${DEVELOPMENT_REDIS_NAMESPACE}pipeline:set`), ["y"]);

await development.set("atomic:guard", "lease-1");
assert.equal(
  await development.setIfValueMatches(
    "atomic:guard",
    "lease-1",
    "atomic:target",
    "owned-value"
  ),
  true
);
assert.equal(
  await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}atomic:target`),
  "owned-value"
);
assert.equal(
  await development.setIfValueMatches(
    "atomic:guard",
    "different-lease",
    "atomic:target",
    "must-not-write"
  ),
  false
);
assert.equal(
  await raw.get(`${DEVELOPMENT_REDIS_NAMESPACE}atomic:target`),
  "owned-value"
);
assert.equal(
  await development.compareAndDelete("atomic:target", "different-owner"),
  false
);
assert.equal(
  await development.compareAndDelete("atomic:target", "owned-value"),
  true
);

class AtomicSpyRedis extends MemoryRedis {
  atomicCalls = [];

  async compareAndDelete(key, expectedValue) {
    this.atomicCalls.push(["compareAndDelete", key, expectedValue]);
    return super.compareAndDelete(key, expectedValue);
  }

  async setIfValueMatches(guardKey, expectedGuardValue, targetKey, value) {
    this.atomicCalls.push([
      "setIfValueMatches",
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
}

const atomicSpyRaw = new AtomicSpyRedis();
const atomicSpyDevelopment = createDevelopmentRedis(atomicSpyRaw);
await atomicSpyDevelopment.set("guard", "enabled");
await atomicSpyDevelopment.setIfValueMatches(
  "guard",
  "enabled",
  "target",
  "owned"
);
await atomicSpyDevelopment.compareAndDelete("target", "owned");
assert.deepEqual(atomicSpyRaw.atomicCalls, [
  [
    "setIfValueMatches",
    `${DEVELOPMENT_REDIS_NAMESPACE}guard`,
    "enabled",
    `${DEVELOPMENT_REDIS_NAMESPACE}target`,
    "owned",
  ],
  [
    "compareAndDelete",
    `${DEVELOPMENT_REDIS_NAMESPACE}target`,
    "owned",
  ],
]);

await assert.rejects(
  development.set(`${DEVELOPMENT_REDIS_NAMESPACE}double`, "blocked"),
  /reserved Development Redis prefix/
);
const doubleWrapped = createDevelopmentRedis(development);
await assert.rejects(
  doubleWrapped.set("order:double", "blocked"),
  /reserved Development Redis prefix/
);

class LeakingMemoryRedis extends MemoryRedis {
  async keys() {
    return ["order:production"];
  }
}
await assert.rejects(
  createDevelopmentRedis(new LeakingMemoryRedis()).keys("order:*"),
  /outside the Development namespace/
);
class DoublePrefixedMemoryRedis extends MemoryRedis {
  async keys() {
    return [`${DEVELOPMENT_REDIS_NAMESPACE}${DEVELOPMENT_REDIS_NAMESPACE}order:1`];
  }
}
await assert.rejects(
  createDevelopmentRedis(new DoublePrefixedMemoryRedis()).keys("order:*"),
  /reserved Development Redis prefix/
);

const productionRaw = new MemoryRedis();
const production = createProductionRedis(productionRaw);
assert.equal(await production.set("order:production", "kept"), "OK");
assert.equal(await productionRaw.get("order:production"), "kept");
assert.deepEqual(await production.keys("order:*"), ["order:production"]);
await assert.rejects(
  production.get(`${DEVELOPMENT_REDIS_NAMESPACE}order:1`),
  /reserved Development Redis prefix/
);
const productionPipeline = production.pipeline();
assert.throws(
  () => productionPipeline.set(`${DEVELOPMENT_REDIS_NAMESPACE}order:1`, "blocked"),
  /reserved Development Redis prefix/
);
await assert.rejects(
  production.keys("*"),
  /could reach the Development namespace/
);
await assert.rejects(
  production.keys("d*"),
  /could reach the Development namespace/
);
await assert.rejects(
  production.keys("dev:*"),
  /could reach the Development namespace/
);
await assert.rejects(
  production.compareAndDelete(
    `${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_token`,
    "blocked"
  ),
  /reserved Development Redis prefix/
);
await assert.rejects(
  production.setIfValueMatches(
    "auth:base_readonly_control",
    "enabled",
    `${DEVELOPMENT_REDIS_NAMESPACE}auth:base_readonly_token`,
    "blocked"
  ),
  /reserved Development Redis prefix/
);

const productionRuntime = resolveRuntimeConfig({
  APP_ENVIRONMENT: "production",
  BASE_DATA_MODE: "production",
  APP_STORE_MODE: "upstash",
  VERCEL_ENV: "production",
});
assert.doesNotThrow(() =>
  assertProductionRuntime(productionRuntime, "contract test")
);
const previewRuntime = resolveRuntimeConfig({
  APP_ENVIRONMENT: "development",
  BASE_DATA_MODE: "readonly",
  APP_STORE_MODE: "upstash",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "codex/development",
});
assert.throws(
  () => assertProductionRuntime(previewRuntime, "contract test"),
  /only available in the validated Production runtime/
);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = ["@", "upstash", "/redis"].join("");
const allowedSdkImport = path.join("lib", "upstash.ts");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const excludedDirectories = new Set([
  ".git",
  ".next",
  ".vercel",
  "coverage",
  "node_modules",
]);
const sdkImports = [];

async function inspectDirectory(relativeDirectory) {
  const absoluteDirectory = path.join(repositoryRoot, relativeDirectory);
  for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
    if (entry.name.startsWith(".env")) continue;
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) continue;
      await inspectDirectory(relativePath);
      continue;
    }
    if (!sourceExtensions.has(path.extname(entry.name))) continue;
    const content = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    if (content.includes(packageName)) sdkImports.push(relativePath);
  }
}

await inspectDirectory("");
assert.deepEqual(sdkImports, [allowedSdkImport]);

console.log("redis namespace contract tests passed");

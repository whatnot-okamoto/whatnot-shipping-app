import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const fixedPowerShellPath =
  "C:\\Users\\okamotok1\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\pwsh.exe";
const fixedNodePath = "C:\\Program Files\\nodejs\\node.exe";
const dummyUrl = "https://nonsecret-readonly.invalid";
const dummyToken = "nonsecret-readonly-token";
const physicalGuard =
  "dev:v1:diagnostic:base_readonly_oauth_atomic:v1:guard";
const auditFileName = "no-network-upstash-audit.json";
const upstashPackageName = ["@", "upstash", "/redis"].join("");

const copiedFiles = [
  "scripts/invoke-upstash-atomic-readonly.ps1",
  "scripts/upstash-atomic-launcher-common.ps1",
  "scripts/upstash-atomic-cli-loader.mjs",
  "scripts/probe-upstash-atomic-readonly.mjs",
  "lib/upstash.ts",
  "lib/upstash-atomic-readonly.ts",
  "lib/upstash-atomic-contract.ts",
  "lib/namespaced-redis.ts",
  "lib/redis-like.ts",
  "lib/memory-redis.ts",
  "lib/runtime-mode.ts",
];
const requiredByteIdenticalFiles = copiedFiles;
const expectedEnvironmentNames = [
  "APP_ENVIRONMENT",
  "APP_STORE_MODE",
  "BASE_DATA_MODE",
  "UPSTASH_REDIS_REST_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_REF",
];
const temporaryRoots = [];

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function fakePackageSource(scenario) {
  const getOutcome =
    scenario === "success"
      ? "return null;"
      : 'throw new Error("Fixed no-network fake unknown failure.");';
  return `import { writeFileSync } from "node:fs";
import path from "node:path";

const auditPath = path.join(process.cwd(), ${JSON.stringify(auditFileName)});
const expectedEnvironment = Object.freeze({
  APP_ENVIRONMENT: "development",
  BASE_DATA_MODE: "readonly",
  APP_STORE_MODE: "upstash",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "codex/development",
  UPSTASH_REDIS_REST_URL: ${JSON.stringify(dummyUrl)},
  UPSTASH_REDIS_REST_TOKEN: ${JSON.stringify(dummyToken)},
});
const state = { constructorCount: 0, calls: [] };

function persist() {
  writeFileSync(auditPath, JSON.stringify(state), "utf8");
}

function assertFixedEnvironment() {
  const expectedNames = Object.keys(expectedEnvironment).sort();
  const actualNames = Object.keys(process.env).sort();
  if (
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames) ||
    !expectedNames.every((name) => process.env[name] === expectedEnvironment[name])
  ) {
    throw new Error("Fixed child environment mismatch.");
  }
}

function forbidden(name, args) {
  state.calls.push([name, ...args]);
  persist();
  throw new Error("Forbidden fake command.");
}

export class Redis {
  constructor() {
    assertFixedEnvironment();
    state.constructorCount += 1;
    persist();
  }

  get(key) {
    state.calls.push(["get", key]);
    persist();
    ${getOutcome}
  }

  set(...args) { return forbidden("set", args); }
  del(...args) { return forbidden("del", args); }
  sadd(...args) { return forbidden("sadd", args); }
  srem(...args) { return forbidden("srem", args); }
  smembers(...args) { return forbidden("smembers", args); }
  keys(...args) { return forbidden("keys", args); }
  eval(...args) { return forbidden("eval", args); }
  pipeline(...args) { return forbidden("pipeline", args); }
}
`;
}

async function createFixture(scenario) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "upstash-readonly-full-path-")
  );
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("upstash-readonly-full-path-"));
  temporaryRoots.push(root);

  for (const relativePath of copiedFiles) {
    const source = path.join(repositoryRoot, relativePath);
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }

  for (const relativePath of requiredByteIdenticalFiles) {
    const sourceBytes = await readFile(path.join(repositoryRoot, relativePath));
    const fixtureBytes = await readFile(path.join(root, relativePath));
    assert.equal(Buffer.compare(sourceBytes, fixtureBytes), 0);
  }

  const fakePackageRoot = path.join(root, "node_modules", "@upstash", "redis");
  await mkdir(fakePackageRoot, { recursive: true });
  await writeFile(
    path.join(fakePackageRoot, "package.json"),
    JSON.stringify({
      name: upstashPackageName,
      type: "module",
      exports: "./index.js",
    }),
    "utf8"
  );
  const fakeSource = fakePackageSource(scenario);
  for (const forbiddenCapability of [
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "node:dns",
    "fetch",
    "WebSocket",
    "EventSource",
    "XMLHttpRequest",
  ]) {
    assert.equal(fakeSource.includes(forbiddenCapability), false);
  }
  await writeFile(path.join(fakePackageRoot, "index.js"), fakeSource, "utf8");

  return root;
}

async function runScenario(scenario) {
  const root = await createFixture(scenario);
  const hostPath = path.join(root, "fixed-readonly-test-host.ps1");
  const launcherPath = path.join(
    root,
    "scripts",
    "invoke-upstash-atomic-readonly.ps1"
  );
  await writeFile(
    hostPath,
    `$fixedInputs = [System.Collections.Generic.Queue[string]]::new()
$fixedInputs.Enqueue(${quotePowerShell(dummyUrl)})
$fixedInputs.Enqueue(${quotePowerShell(dummyToken)})
function Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  if (-not $AsSecureString -or $fixedInputs.Count -eq 0) { throw "fixed input unavailable" }
  return ConvertTo-SecureString -String $fixedInputs.Dequeue() -AsPlainText -Force
}
& ${quotePowerShell(launcherPath)}
exit $LASTEXITCODE
`,
    "utf8"
  );

  const result = spawnSync(
    fixedPowerShellPath,
    ["-NoLogo", "-NoProfile", "-File", hostPath],
    {
      cwd: root,
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    }
  );
  const audit = JSON.parse(
    await readFile(path.join(root, auditFileName), "utf8")
  );
  return { root, result, audit };
}

assert.equal(existsSync(fixedPowerShellPath), true);
assert.equal(existsSync(fixedNodePath), true);
const powerShellVersion = spawnSync(
  fixedPowerShellPath,
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$PSVersionTable.PSVersion.ToString()",
  ],
  {
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
    encoding: "utf8",
    windowsHide: true,
  }
);
assert.equal(powerShellVersion.status, 0);
assert.equal(powerShellVersion.stdout.trim(), "7.6.4");
const nodeVersion = spawnSync(fixedNodePath, ["--version"], {
  env: {},
  encoding: "utf8",
  windowsHide: true,
});
assert.equal(nodeVersion.status, 0);
assert.equal(nodeVersion.stdout.trim(), "v22.14.0");

try {
  for (const [scenario, classification, exitCode] of [
    ["success", "PASS_READONLY_BOUNDARY", 0],
    ["unknown", "STOP_READONLY_BEFORE_FETCH", 35],
  ]) {
    const { result, audit } = await runScenario(scenario);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, exitCode);
    assert.deepEqual(result.stdout.split(/\r?\n/), [classification, ""]);
    assert.equal(result.stderr, "");
    assert.deepEqual(Object.keys(audit).sort(), ["calls", "constructorCount"]);
    assert.equal(audit.constructorCount, 2);
    assert.deepEqual(audit.calls, [["get", physicalGuard]]);
    assert.deepEqual(expectedEnvironmentNames, [...expectedEnvironmentNames].sort());
  }
} finally {
  for (const root of temporaryRoots) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("upstash-readonly-full-path-"));
    await rm(root, { recursive: true, force: true });
  }
}

process.stdout.write("Upstash atomic read-only full-path tests passed\n");

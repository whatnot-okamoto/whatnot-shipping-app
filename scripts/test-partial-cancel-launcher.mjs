import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname.slice(1));
const launcherPath = join(
  repositoryRoot,
  "scripts",
  "invoke-partial-cancel-diagnostic.ps1"
);
const childFixturePath = join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "partial-cancel-launcher-child.mjs"
);
const grandchildFixturePath = join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "partial-cancel-launcher-grandchild.mjs"
);
const harnessPath = join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "invoke-partial-cancel-diagnostic-harness.ps1"
);
const pwshPath =
  "C:\\Users\\okamotok1\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\pwsh.exe";
const source = readFileSync(launcherPath, "utf8");

assert.equal(source.includes("ReadToEndAsync"), false);
assert.equal(source.includes("Get-Process"), false);
assert.equal(source.includes("RedirectStandardInput = $false"), true);
assert.equal(source.includes("RedirectStandardOutput = $true"), true);
assert.equal(source.includes("RedirectStandardError = $true"), true);
assert.equal(source.includes("$OwnedChild.Kill($true)"), true);
assert.equal(source.includes("$TOKEN_MAX_CHARACTERS = 4096"), true);
assert.equal(source.includes("$STDOUT_MAX_BYTES = 16384"), true);
assert.equal(source.includes("$STDERR_MAX_BYTES = 256"), true);
assert.equal(source.includes("$PROCESS_WATCHDOG_MS = 180000"), true);
assert.equal(source.includes("$POST_KILL_WAIT_MS = 10000"), true);
assert.equal(
  (source.match(/\.Environment\.Add\(/g) ?? []).length,
  3
);
assert.deepEqual(
  [...source.matchAll(/\.Environment\.Add\("([A-Z_]+)"/g)].map(
    (match) => match[1]
  ),
  ["APP_ENVIRONMENT", "BASE_DATA_MODE", "BASE_READONLY_ACCESS_TOKEN"]
);
assert.ok(
  source.indexOf("$startInfo.Environment.Clear()") <
    source.indexOf('$startInfo.Environment.Add("APP_ENVIRONMENT"')
);
assert.ok(
  source.indexOf("$processStarted = $true") <
    source.indexOf("$startInfo.Environment.Clear()", source.indexOf("$processStarted = $true"))
);
assert.ok((source.match(/\$startInfo\.Environment\.Clear\(\)/g) ?? []).length >= 3);
assert.equal(source.includes("BASE_API_TOKEN"), false);
assert.equal(source.includes("UPSTASH"), false);
assert.equal(source.includes("VERCEL"), false);
assert.equal(source.includes("http://"), false);
assert.equal(source.includes("https://"), false);
assert.equal(source.includes("GetEnvironmentVariable"), false);

for (const fixturePath of [childFixturePath, grandchildFixturePath, harnessPath]) {
  const fixtureSource = readFileSync(fixturePath, "utf8");
  assert.equal(/\bfetch\s*\(/.test(fixtureSource), false);
  assert.equal(/node:(?:http|https|net|tls|dgram)/.test(fixtureSource), false);
}

function runHarness(token) {
  return spawnSync(
    pwshPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, PARTIAL_CANCEL_TEST_TOKEN: token },
    }
  );
}

const success = runHarness("success");
assert.equal(success.error, undefined);
assert.equal(success.status, 0, success.stderr);
assert.equal(success.stderr, "");
assert.equal(success.stdout.split("\n").length, 2);
assert.equal(JSON.parse(success.stdout).outcome, "pass_enum_complete");

const indeterminate = runHarness("indeterminate");
assert.equal(indeterminate.status, 20);
assert.equal(JSON.parse(indeterminate.stdout).outcome, "stop_indeterminate");
assert.equal(indeterminate.stderr, "STOP_ENUM_INDETERMINATE\r\n");

for (const [code, exitCode] of Object.entries({
  STOP_RUNTIME_BOUNDARY: 21,
  STOP_INPUT: 22,
  STOP_TIMEOUT: 23,
  STOP_TRANSPORT: 24,
  STOP_HTTP: 25,
  STOP_RESPONSE_TOO_LARGE: 26,
  STOP_RESPONSE_BODY: 27,
  STOP_RESPONSE_SCHEMA: 28,
  STOP_INTERNAL: 29,
})) {
  const result = runHarness(`child-error:${code}`);
  assert.equal(result.status, exitCode, `${code} exit code`);
  assert.equal(result.stdout, "", `${code} stdout`);
  assert.equal(result.stderr, `${code}\r\n`, `${code} stderr`);
}

const emptyToken = runHarness("__EMPTY__");
assert.equal(emptyToken.status, 30);
assert.equal(emptyToken.stdout, "");
assert.equal(emptyToken.stderr, "STOP_TOKEN_INPUT\r\n");

const oversizedToken = runHarness("x".repeat(4_097));
assert.equal(oversizedToken.status, 31);
assert.equal(oversizedToken.stdout, "");
assert.equal(oversizedToken.stderr, "STOP_TOKEN_TOO_LARGE\r\n");

const fixedChildFailure = runHarness("fixed-child-failure");
assert.equal(fixedChildFailure.status, 22);
assert.equal(fixedChildFailure.stdout, "");
assert.equal(fixedChildFailure.stderr, "STOP_INPUT\r\n");

const unexpectedStdout = runHarness("unexpected-stdout");
assert.equal(unexpectedStdout.status, 34);
assert.equal(unexpectedStdout.stdout, "");
assert.equal(unexpectedStdout.stderr, "STOP_OUTPUT_CONTRACT\r\n");
assert.equal(unexpectedStdout.stderr.includes("UNSAFE_RAW_OUTPUT"), false);

for (const invalidContractToken of [
  "extra-schema-key",
  "invalid-schema-enum",
  "invalid-semantic-combination",
  "mismatched-exit",
]) {
  const invalidContract = runHarness(invalidContractToken);
  assert.equal(invalidContract.status, 34, invalidContractToken);
  assert.equal(invalidContract.stdout, "", invalidContractToken);
  assert.equal(
    invalidContract.stderr,
    "STOP_OUTPUT_CONTRACT\r\n",
    invalidContractToken
  );
}

const stdoutOverflow = runHarness("stdout-overflow");
assert.equal(stdoutOverflow.status, 32);
assert.equal(stdoutOverflow.stdout, "");
assert.equal(stdoutOverflow.stderr, "STOP_STDOUT_TOO_LARGE\r\n");

const stderrOverflow = runHarness("stderr-overflow");
assert.equal(stderrOverflow.status, 33);
assert.equal(stderrOverflow.stdout, "");
assert.equal(stderrOverflow.stderr, "STOP_STDERR_TOO_LARGE\r\n");

const markerPath = join(tmpdir(), `partial-cancel-grandchild-${randomUUID()}.txt`);
assert.equal(existsSync(markerPath), false);
const watchdogToken = `watchdog:${Buffer.from(markerPath, "utf8").toString("base64url")}`;
const watchdog = runHarness(watchdogToken);
assert.equal(watchdog.status, 35);
assert.equal(watchdog.stdout, "");
assert.equal(watchdog.stderr, "STOP_CHILD_WATCHDOG\r\n");
await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_800));
assert.equal(existsSync(markerPath), false, "owned grandchild must be terminated");

console.log("partial cancel launcher tests passed");

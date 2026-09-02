import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
const scriptsRoot = path.join(repositoryRoot, "scripts");
const diagnosticLauncherName = "invoke-upstash-atomic-diagnostic.ps1";
const recoveryLauncherName = "invoke-upstash-atomic-recovery.ps1";
const diagnosticCliName = "diagnose-upstash-atomic.mjs";
const recoveryCliName = "recover-upstash-atomic.mjs";
const loaderName = "upstash-atomic-cli-loader.mjs";
const dummyUrl = "https://nonsecret-diagnostic.invalid";
const dummyToken = "nonsecret-diagnostic-token";
const rawSentinel = "RAW_CHILD_DETAIL_MUST_NOT_SURFACE";

const diagnosticResults = new Map([
  ["PASS_ATOMIC_CONTRACT", 0],
  ["STOP_DIAGNOSTIC_KEYS_PRESENT", 10],
  ["STOP_CONTRACT_MISMATCH", 11],
  ["STOP_ATOMIC_INDETERMINATE", 12],
  ["STOP_RUNTIME_BOUNDARY", 13],
]);
const recoveryResults = new Map([
  ["PASS_RECOVERY_COMPLETE", 0],
  ["STOP_RECOVERY_VALUE_UNEXPECTED", 20],
  ["STOP_RECOVERY_INDETERMINATE", 21],
  ["STOP_RUNTIME_BOUNDARY", 13],
]);

const sources = {
  diagnostic: await readFile(
    path.join(scriptsRoot, diagnosticLauncherName),
    "utf8"
  ),
  recovery: await readFile(
    path.join(scriptsRoot, recoveryLauncherName),
    "utf8"
  ),
};

const allowedEnvironmentNames = [
  "APP_ENVIRONMENT",
  "BASE_DATA_MODE",
  "APP_STORE_MODE",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_REF",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

for (const source of Object.values(sources)) {
  assert.ok(source.indexOf("$args.Count") < source.indexOf("Read-Host"));
  assert.equal((source.match(/Read-Host/g) ?? []).length, 2);
  assert.equal((source.match(/-AsSecureString/g) ?? []).length, 2);
  assert.ok(source.indexOf("$PSVersionTable.PSEdition") < source.indexOf("Read-Host"));
  assert.match(source, /\$PSVersionTable\.PSEdition -ne "Core"/);
  assert.match(source, /\$PSVersionTable\.PSVersion\.Major -lt 7/);
  assert.match(source, /\$PROCESS_WATCHDOG_MS = 180000/);
  assert.match(source, /\$NODE_PATH = "C:\\Program Files\\nodejs\\node\.exe"/);
  assert.match(source, /UseShellExecute = \$false/);
  assert.match(source, /CreateNoWindow = \$true/);
  assert.match(source, /RedirectStandardInput = \$true/);
  assert.match(source, /RedirectStandardOutput = \$true/);
  assert.match(source, /RedirectStandardError = \$true/);
  assert.match(source, /Environment\.Clear\(\)/);
  assert.match(source, /StandardOutput\.ReadToEndAsync\(\)/);
  assert.match(source, /StandardError\.ReadToEndAsync\(\)/);
  assert.ok(
    source.indexOf("StandardOutput.ReadToEndAsync()") <
      source.indexOf("WaitForExit($PROCESS_WATCHDOG_MS)")
  );
  assert.ok(
    source.indexOf("StandardError.ReadToEndAsync()") <
      source.indexOf("WaitForExit($PROCESS_WATCHDOG_MS)")
  );
  assert.match(source, /StandardInput\.Close\(\)/);
  assert.match(source, /\$fixedResults\.Keys -ccontains \$candidate/);
  assert.match(source, /\$childProcess\.Kill\(\)/);
  assert.match(
    source,
    /\$childExitConfirmed = \$childProcess\.WaitForExit\(\$POST_KILL_WAIT_MS\)/
  );
  assert.equal(source.includes("Kill($true)"), false);
  assert.equal(source.includes("Stop-Process"), false);
  assert.equal(source.toLowerCase().includes("taskkill"), false);
  assert.match(source, /ZeroFreeBSTR\(\$urlBstr\)/);
  assert.match(source, /ZeroFreeBSTR\(\$tokenBstr\)/);
  assert.match(source, /\$urlSecure\.Dispose\(\)/);
  assert.match(source, /\$tokenSecure\.Dispose\(\)/);
  assert.match(source, /\$urlPlain = \$null/);
  assert.match(source, /\$tokenPlain = \$null/);
  assert.match(source, /\$capturedStdout = \$null/);
  assert.match(source, /\$capturedStderr = \$null/);
  assert.equal(source.includes("$env:"), false);
  assert.equal(source.includes("Start-Process"), false);
  assert.equal(/\bnpm\b/i.test(source), false);
  assert.equal(/\.env(?:\*|\b)/i.test(source), false);
  assert.equal(/\bKEYS\b/.test(source), false);
  assert.equal(/\bSCAN\b/.test(source), false);
  assert.equal(source.includes("auth:base_readonly_"), false);
  assert.equal(source.includes("auth:base_token"), false);
  assert.equal(/vercel(?:\.exe)?\s+(?:env|link|login)/i.test(source), false);

  const addedNames = [...source.matchAll(/Environment\.Add\("([A-Z_]+)"/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(addedNames, allowedEnvironmentNames);

  const argumentStart = source.indexOf("$startInfo.ArgumentList.Add");
  const childStart = source.indexOf(
    "$childProcess = [System.Diagnostics.Process]::new()",
    argumentStart
  );
  assert.ok(argumentStart >= 0);
  assert.ok(childStart > argumentStart);
  const argumentBlock = source.slice(argumentStart, childStart);
  assert.equal(argumentBlock.includes("$urlPlain"), false);
  assert.equal(argumentBlock.includes("$tokenPlain"), false);
  assert.equal(argumentBlock.includes("$loaderPath"), false);
  assert.equal(argumentBlock.includes("$cliPath"), false);
  assert.equal((argumentBlock.match(/ArgumentList\.Add/g) ?? []).length, 6);
}

assert.ok(
  sources.diagnostic.includes(
    '$startInfo.ArgumentList.Add("./scripts/diagnose-upstash-atomic.mjs")'
  )
);
assert.ok(
  sources.recovery.includes(
    '$startInfo.ArgumentList.Add("./scripts/recover-upstash-atomic.mjs")'
  )
);
assert.equal(sources.diagnostic.includes(recoveryCliName), false);
assert.equal(sources.diagnostic.includes("--confirm-fixed-recovery"), false);
assert.equal(sources.recovery.includes(diagnosticCliName), false);
assert.equal(sources.recovery.includes("--confirm-fixed-diagnostic"), false);

for (const [classification, exitCode] of diagnosticResults) {
  assert.ok(sources.diagnostic.includes(`"${classification}" = ${exitCode}`));
}
for (const [classification, exitCode] of recoveryResults) {
  assert.ok(sources.recovery.includes(`"${classification}" = ${exitCode}`));
}

const powerShellProbe = spawnSync(
  "pwsh.exe",
  ["-NoLogo", "-NoProfile", "-Command", "(Get-Process -Id $PID).Path"],
  { encoding: "utf8", windowsHide: true }
);
assert.equal(powerShellProbe.status, 0);
const powerShellPath = powerShellProbe.stdout.trim();
assert.ok(path.isAbsolute(powerShellPath));

const powerShellEnvironment = {};
for (const name of ["SystemRoot", "WINDIR"]) {
  if (process.env[name]) powerShellEnvironment[name] = process.env[name];
}

const temporaryRoots = [];
let testHostSequence = 0;

async function createFixtureTree(launcherName, cliName, launcherSource = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "upstash-launcher-test-"));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  temporaryRoots.push(root);
  const fixtureScripts = path.join(root, "scripts");
  await mkdir(fixtureScripts);
  if (launcherSource === null) {
    await copyFile(
      path.join(scriptsRoot, launcherName),
      path.join(fixtureScripts, launcherName)
    );
  } else {
    await writeFile(path.join(fixtureScripts, launcherName), launcherSource);
  }
  await writeFile(
    path.join(fixtureScripts, loaderName),
    "export async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); }\n"
  );
  return {
    root,
    launcherPath: path.join(fixtureScripts, launcherName),
    cliPath: path.join(fixtureScripts, cliName),
  };
}

function runLauncher(
  fixture,
  {
    args = [],
    secureInputs = [dummyUrl, dummyToken],
    timeout = 10_000,
  } = {}
) {
  const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
  const testHostPath = path.join(
    fixture.root,
    `fixed-test-host-${testHostSequence++}.ps1`
  );
  const queuedInputs = secureInputs
    .map((value) => `$fixedInputs.Enqueue(${quotePowerShell(value)})`)
    .join("\n");
  const launcherArguments = args.map(quotePowerShell).join(" ");
  writeFileSync(
    testHostPath,
    `$fixedInputs = [System.Collections.Generic.Queue[string]]::new()
${queuedInputs}
function Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if (-not $AsSecureString -or $fixedInputs.Count -eq 0) { throw "fixed test input unavailable" }
    return ConvertTo-SecureString -String $fixedInputs.Dequeue() -AsPlainText -Force
}
& ${quotePowerShell(fixture.launcherPath)} ${launcherArguments}
exit $LASTEXITCODE
`
  );
  return spawnSync(
    powerShellPath,
    ["-NoLogo", "-NoProfile", "-File", testHostPath],
    {
      cwd: fixture.root,
      env: powerShellEnvironment,
      encoding: "utf8",
      timeout,
      windowsHide: true,
    }
  );
}

function assertWrapperResult(
  result,
  expectedClassification,
  expectedExitCode,
  forbiddenOutput = []
) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, expectedExitCode);
  assert.equal(result.stderr, "");
  const outputLines = result.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(outputLines.at(-1), expectedClassification);
  for (const forbidden of [dummyUrl, dummyToken, rawSentinel, ...forbiddenOutput]) {
    assert.equal(result.stdout.includes(forbidden), false);
    assert.equal(result.stderr.includes(forbidden), false);
  }
}

function childSource({ stdout, stderr = "", exitCode, validateBoundary = false }) {
  const validation = validateBoundary
    ? `
const expectedEnvironment = ${JSON.stringify({
        APP_ENVIRONMENT: "development",
        BASE_DATA_MODE: "readonly",
        APP_STORE_MODE: "upstash",
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "codex/development",
        UPSTASH_REDIS_REST_URL: dummyUrl,
        UPSTASH_REDIS_REST_TOKEN: dummyToken,
      })};
const expectedNames = Object.keys(expectedEnvironment).sort();
const actualNames = Object.keys(process.env).sort();
const environmentMatches = JSON.stringify(actualNames) === JSON.stringify(expectedNames) &&
  expectedNames.every((name) => process.env[name] === expectedEnvironment[name]);
const argumentsAreClean = !process.argv.some((value) => value.includes(dummyUrl) || value.includes(dummyToken));
if (!environmentMatches || !argumentsAreClean) {
  process.stdout.write("FIXTURE_BOUNDARY_MISMATCH\\n");
  process.exit(98);
}
`
    : "";
  return `
const dummyUrl = ${JSON.stringify(dummyUrl)};
const dummyToken = ${JSON.stringify(dummyToken)};
${validation}
let completed = false;
const finish = () => {
  if (completed) return;
  completed = true;
  process.stdout.write(${JSON.stringify(stdout)});
  process.stderr.write(${JSON.stringify(stderr)});
  process.exit(${exitCode});
};
queueMicrotask(finish);
`;
}

try {
  // Arguments stop before prompts and before any child can start.
  for (const [launcherName, cliName] of [
    [diagnosticLauncherName, diagnosticCliName],
    [recoveryLauncherName, recoveryCliName],
  ]) {
    const fixture = await createFixtureTree(launcherName, cliName);
    const result = runLauncher(fixture, {
      args: ["--unexpected"],
      secureInputs: [],
    });
    assertWrapperResult(result, "STOP_RUNTIME_BOUNDARY", 13);
  }

  // A missing fixed child is a pre-start runtime-boundary failure.
  {
    const fixture = await createFixtureTree(
      diagnosticLauncherName,
      diagnosticCliName
    );
    const result = runLauncher(fixture, { secureInputs: [] });
    assertWrapperResult(result, "STOP_RUNTIME_BOUNDARY", 13);
  }

  // Empty secure input stops before process start.
  {
    const fixture = await createFixtureTree(
      diagnosticLauncherName,
      diagnosticCliName
    );
    await writeFile(
      fixture.cliPath,
      childSource({ stdout: "PASS_ATOMIC_CONTRACT\n", exitCode: 0 })
    );
    const result = runLauncher(fixture, { secureInputs: [""] });
    assertWrapperResult(result, "STOP_RUNTIME_BOUNDARY", 13);
  }

  // Every declared child classification is adopted only with its exact exit.
  for (const [launcherName, cliName, resultMap] of [
    [diagnosticLauncherName, diagnosticCliName, diagnosticResults],
    [recoveryLauncherName, recoveryCliName, recoveryResults],
  ]) {
    for (const [classification, exitCode] of resultMap) {
      const fixture = await createFixtureTree(launcherName, cliName);
      await writeFile(
        fixture.cliPath,
        childSource({
          stdout: `${classification}\n`,
          exitCode,
          validateBoundary: classification.startsWith("PASS_"),
        })
      );
      const result = runLauncher(fixture);
      assertWrapperResult(result, classification, exitCode);
    }
  }

  // Any stderr, malformed/multiple stdout, or exit mismatch is indeterminate.
  for (const scenario of [
    {
      stdout: "PASS_ATOMIC_CONTRACT\n",
      stderr: `${rawSentinel}\n`,
      exitCode: 0,
    },
    { stdout: `${rawSentinel}\n`, exitCode: 0 },
    { stdout: "pass_atomic_contract\n", exitCode: 0 },
    { stdout: "PASS_ATOMIC_CONTRACT\nEXTRA\n", exitCode: 0 },
    { stdout: "PASS_ATOMIC_CONTRACT\n", exitCode: 11 },
  ]) {
    const fixture = await createFixtureTree(
      diagnosticLauncherName,
      diagnosticCliName
    );
    await writeFile(fixture.cliPath, childSource(scenario));
    const result = runLauncher(fixture);
    assertWrapperResult(result, "STOP_ATOMIC_INDETERMINATE", 12);
  }

  // The fixed child receives EOF rather than an inherited interactive stdin.
  {
    const fixture = await createFixtureTree(
      diagnosticLauncherName,
      diagnosticCliName
    );
    await writeFile(
      fixture.cliPath,
      `let done = false;
process.stdin.once("end", () => {
  done = true;
  process.stdout.write("PASS_ATOMIC_CONTRACT\\n");
  process.exit(0);
});
process.stdin.resume();
setTimeout(() => {
  if (!done) {
    process.stdout.write("FIXTURE_STDIN_NOT_CLOSED\\n");
    process.exit(97);
  }
}, 1000);
`
    );
    const result = runLauncher(fixture);
    assertWrapperResult(result, "PASS_ATOMIC_CONTRACT", 0);
  }

  // A post-start syntax failure is also indeterminate and its raw stderr stays hidden.
  {
    const fixture = await createFixtureTree(
      recoveryLauncherName,
      recoveryCliName
    );
    await writeFile(fixture.cliPath, "this is not valid javascript {{{\n");
    const result = runLauncher(fixture);
    assertWrapperResult(result, "STOP_RECOVERY_INDETERMINATE", 21, [
      "SyntaxError",
    ]);
  }

  // Concurrent async reads prevent a full stderr pipe from deadlocking.
  {
    const fixture = await createFixtureTree(
      diagnosticLauncherName,
      diagnosticCliName
    );
    await writeFile(
      fixture.cliPath,
      `process.stderr.write(${JSON.stringify(rawSentinel)});\nprocess.stderr.write("x".repeat(1024 * 1024));\nprocess.stdout.write("PASS_ATOMIC_CONTRACT\\n");\nprocess.exit(0);\n`
    );
    const result = runLauncher(fixture);
    assertWrapperResult(result, "STOP_ATOMIC_INDETERMINATE", 12);
  }

  // Exercise the watchdog with a shortened test-only copy. Production source
  // remains fixed at 180 seconds and exposes no timeout parameter.
  {
    const shortened = sources.diagnostic.replace(
      "$PROCESS_WATCHDOG_MS = 180000",
      "$PROCESS_WATCHDOG_MS = 250"
    );
    assert.notEqual(shortened, sources.diagnostic);
    const fixture = await createFixtureTree(
      diagnosticLauncherName,
      diagnosticCliName,
      shortened
    );
    await writeFile(fixture.cliPath, "setInterval(() => {}, 1000);\n");
    const startedAt = Date.now();
    const result = runLauncher(fixture, { timeout: 5_000 });
    assert.ok(Date.now() - startedAt < 5_000);
    assertWrapperResult(result, "STOP_ATOMIC_INDETERMINATE", 12);
  }
} finally {
  for (const root of temporaryRoots) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

console.log("Upstash atomic PowerShell launcher tests passed");

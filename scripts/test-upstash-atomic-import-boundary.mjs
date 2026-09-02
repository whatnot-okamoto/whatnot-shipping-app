import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const nodePath = "C:\\Program Files\\nodejs\\node.exe";
const expectedOutput = "UPSTASH_ATOMIC_IMPORT_BOUNDARY_OK\n";
const fixedEnvironment = Object.freeze({
  APP_ENVIRONMENT: "development",
  BASE_DATA_MODE: "readonly",
  APP_STORE_MODE: "upstash",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "codex/development",
  UPSTASH_REDIS_REST_URL: "https://nonsecret-import-boundary.invalid",
  UPSTASH_REDIS_REST_TOKEN: "nonsecret-import-boundary-token",
});
const forbiddenFakeCapabilities = [
  "import ",
  "require(",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "node:dns",
  "fetch(",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
];

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function createPowerShellHostCommand() {
  const argumentLines = [
    "--no-warnings",
    "--experimental-strip-types",
    "--experimental-loader",
    "./scripts/upstash-atomic-cli-loader.mjs",
    "--experimental-loader",
    "./scripts/upstash-atomic-import-test-loader.mjs",
    "./scripts/upstash-atomic-import-fixture.mjs",
  ]
    .map(
      (argument) =>
        `$startInfo.ArgumentList.Add(${quotePowerShell(argument)})`
    )
    .join("\n");
  const environmentLines = Object.entries(fixedEnvironment)
    .map(
      ([name, value]) =>
        `$startInfo.Environment.Add(${quotePowerShell(name)}, ${quotePowerShell(value)})`
    )
    .join("\n");

  return `$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$childProcess = $null
$stdoutTask = $null
$stderrTask = $null
try {
  $startInfo.FileName = ${quotePowerShell(nodePath)}
  $startInfo.WorkingDirectory = ${quotePowerShell(repositoryRoot)}
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.Environment.Clear()
${environmentLines}
${argumentLines}
  $childProcess = [System.Diagnostics.Process]::new()
  $childProcess.StartInfo = $startInfo
  if (-not $childProcess.Start()) { throw "fixed child did not start" }
  $stdoutTask = $childProcess.StandardOutput.ReadToEndAsync()
  $stderrTask = $childProcess.StandardError.ReadToEndAsync()
  $childProcess.StandardInput.Close()
  if (-not $childProcess.WaitForExit(15000)) {
    try { $childProcess.Kill() } catch {}
    throw "fixed child timed out"
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($stderr.Length -ne 0) { throw "fixed child wrote stderr" }
  [Console]::Out.Write($stdout)
  exit $childProcess.ExitCode
}
catch {
  [Console]::Out.Write("FIXTURE_HOST_STOP\n")
  exit 1
}
finally {
  try { $startInfo.Environment.Clear() } catch {}
  if ($childProcess -ne $null) {
    try { $childProcess.StandardInput.Dispose() } catch {}
    try { $childProcess.StandardOutput.Dispose() } catch {}
    try { $childProcess.StandardError.Dispose() } catch {}
    try { $childProcess.Dispose() } catch {}
  }
}`;
}

function fail() {
  process.stderr.write("Upstash atomic import boundary test failed\n");
  process.exitCode = 1;
}

try {
  const upstashSource = readFileSync(
    path.join(repositoryRoot, "lib", "upstash.ts"),
    "utf8"
  );
  stripTypeScriptTypes(upstashSource);

  const fakeSource = readFileSync(
    path.join(
      repositoryRoot,
      "scripts",
      "upstash-atomic-no-network-fake.mjs"
    ),
    "utf8"
  );
  if (forbiddenFakeCapabilities.some((token) => fakeSource.includes(token))) {
    throw new Error("No-network fake gained a communication capability.");
  }

  const powerShellProbe = spawnSync(
    "pwsh.exe",
    ["-NoLogo", "-NoProfile", "-Command", "(Get-Process -Id $PID).Path"],
    { encoding: "utf8", windowsHide: true }
  );
  if (
    powerShellProbe.error !== undefined ||
    powerShellProbe.status !== 0 ||
    !path.isAbsolute(powerShellProbe.stdout.trim())
  ) {
    throw new Error("PowerShell 7 fixture host was unavailable.");
  }

  const result = spawnSync(
    powerShellProbe.stdout.trim(),
    ["-NoLogo", "-NoProfile", "-Command", createPowerShellHostCommand()],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    }
  );

  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    result.stdout !== expectedOutput ||
    result.stderr !== ""
  ) {
    throw new Error("Fixed import fixture did not pass.");
  }

  process.stdout.write("Upstash atomic import boundary tests passed\n");
} catch {
  fail();
}

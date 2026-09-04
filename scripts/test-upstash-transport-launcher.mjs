import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const scriptsRoot = path.join(repositoryRoot, "scripts");
const launcherName = "invoke-upstash-transport-probe.ps1";
const cliName = "probe-upstash-transport.mjs";
const loaderName = "upstash-transport-cli-loader.mjs";
const fixedPowerShellPath =
  "C:\\Users\\okamotok1\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\pwsh.exe";
const dummyUrl = "https://transport-launcher.invalid";
const selectedAddress = "192.0.2.41";
const rawSentinel = "RAW_TRANSPORT_WRAPPER_DETAIL_MUST_NOT_SURFACE";
const resultMap = new Map([
  ["PASS_TRANSPORT_TLS", 0],
  ["STOP_TRANSPORT_DNS", 40],
  ["STOP_TRANSPORT_TCP", 41],
  ["STOP_TRANSPORT_TLS", 42],
  ["STOP_TRANSPORT_TIMEOUT", 43],
  ["STOP_TRANSPORT_INDETERMINATE", 44],
]);
const wrapperResult = Object.freeze({
  classification: "STOP_TRANSPORT_WRAPPER_INDETERMINATE",
  exitCode: 45,
});
const temporaryRoots = [];
let hostSequence = 0;

const launcherSource = await readFile(
  path.join(scriptsRoot, launcherName),
  "utf8"
);
const cliSource = await readFile(path.join(scriptsRoot, cliName), "utf8");
const loaderSource = await readFile(path.join(scriptsRoot, loaderName), "utf8");

assert.match(launcherSource, /^param\(\)/);
assert.ok(launcherSource.indexOf("$args.Count") < launcherSource.indexOf("Read-Host"));
assert.equal((launcherSource.match(/Read-Host/g) ?? []).length, 1);
assert.equal((launcherSource.match(/-AsSecureString/g) ?? []).length, 1);
assert.match(launcherSource, /\$NODE_PATH = "C:\\Program Files\\nodejs\\node\.exe"/);
assert.match(launcherSource, /\$PROCESS_WATCHDOG_MS = 180000/);
assert.match(launcherSource, /UseShellExecute = \$false/);
assert.match(launcherSource, /CreateNoWindow = \$true/);
assert.match(launcherSource, /RedirectStandardInput = \$true/);
assert.match(launcherSource, /RedirectStandardOutput = \$true/);
assert.match(launcherSource, /RedirectStandardError = \$true/);
assert.match(launcherSource, /Environment\.Clear\(\)/);
assert.deepEqual(
  [...launcherSource.matchAll(/Environment\.Add\("([A-Z_]+)"/g)].map(
    (match) => match[1]
  ),
  ["UPSTASH_REDIS_REST_URL"]
);
assert.equal(/TOKEN/i.test(launcherSource), false);
assert.equal(launcherSource.includes("$env:"), false);
assert.equal(launcherSource.includes("Start-Process"), false);
assert.equal(/\bnpm\b/i.test(launcherSource), false);
assert.equal(/\.env(?:\*|\b)/i.test(launcherSource), false);
assert.equal(/\bKEYS\b|\bSCAN\b/.test(launcherSource), false);
assert.equal(launcherSource.includes("auth:base_"), false);
for (const source of [launcherSource, cliSource, loaderSource]) {
  assert.equal(/TOKEN/i.test(source), false);
  assert.equal(/@upstash/.test(source), false);
  assert.equal(/node:https?|node:http2/.test(source), false);
  assert.equal(/\bfetch\b/.test(source), false);
  assert.equal(/socket\.write/.test(source), false);
  assert.equal(/\.get\(|\.set\(|\.del\(|\.eval\(|\.pipeline\(|["'](?:KEYS|SCAN)["']/i.test(source), false);
  assert.equal(source.includes("diagnose-upstash-atomic"), false);
  assert.equal(source.includes("recover-upstash-atomic"), false);
  assert.equal(source.includes("probe-upstash-atomic-readonly"), false);
}
for (const existingLauncher of [
  "invoke-upstash-atomic-diagnostic.ps1",
  "invoke-upstash-atomic-recovery.ps1",
  "invoke-upstash-atomic-readonly.ps1",
]) {
  const existingSource = await readFile(path.join(scriptsRoot, existingLauncher), "utf8");
  assert.equal(existingSource.includes(launcherName), false);
  assert.equal(existingSource.includes(cliName), false);
}
assert.match(launcherSource, /StandardOutput\.ReadToEndAsync\(\)/);
assert.match(launcherSource, /StandardError\.ReadToEndAsync\(\)/);
assert.ok(
  launcherSource.indexOf("StandardOutput.ReadToEndAsync()") <
    launcherSource.indexOf("WaitForExit($PROCESS_WATCHDOG_MS)")
);
assert.ok(
  launcherSource.indexOf("StandardError.ReadToEndAsync()") <
    launcherSource.indexOf("WaitForExit($PROCESS_WATCHDOG_MS)")
);
assert.match(launcherSource, /StandardInput\.Close\(\)/);
assert.match(launcherSource, /\$childProcess\.Kill\(\)/);
assert.equal(launcherSource.includes("Kill($true)"), false);
assert.equal(launcherSource.includes("Stop-Process"), false);
assert.match(launcherSource, /ZeroFreeBSTR\(\$urlBstr\)/);
assert.match(launcherSource, /\$urlSecure\.Dispose\(\)/);
assert.match(launcherSource, /\$urlPlain = \$null/);
assert.match(launcherSource, /\$capturedStdout = \$null/);
assert.match(launcherSource, /\$capturedStderr = \$null/);
assert.match(launcherSource, /\$parsedUrl\.Port -ne 443/);
for (const token of [
  "IsNullOrWhiteSpace",
  "[char]::IsWhiteSpace",
  '$Url.Contains("`r")',
  '$Url.Contains("`n")',
  "UPSTASH_REDIS_REST_URL=",
  "UriKind]::Absolute",
  "UriSchemeHttps",
  "UserInfo",
  "Query",
  "Fragment",
  "DnsSafeHost",
]) {
  assert.ok(launcherSource.includes(token));
}
for (const [classification, exitCode] of resultMap) {
  assert.ok(launcherSource.includes(`"${classification}" = ${exitCode}`));
}
assert.ok(launcherSource.includes(wrapperResult.classification));
assert.ok(launcherSource.includes(String(wrapperResult.exitCode)));
assert.match(launcherSource, /\$finalClassification = "STOP_RUNTIME_BOUNDARY"/);
assert.match(launcherSource, /\$finalExitCode = 13/);

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function createFixture({ source = launcherSource, cliSource, loaderSource }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "upstash-transport-launcher-"));
  temporaryRoots.push(root);
  const fixtureScripts = path.join(root, "scripts");
  await mkdir(fixtureScripts);
  await writeFile(path.join(fixtureScripts, launcherName), source);
  await writeFile(
    path.join(fixtureScripts, cliName),
    cliSource ?? 'process.stdout.write("PASS_TRANSPORT_TLS\\n"); process.exitCode = 0;\n'
  );
  await writeFile(
    path.join(fixtureScripts, loaderName),
    loaderSource ??
      "export async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); }\n"
  );
  return {
    root,
    launcherPath: path.join(fixtureScripts, launcherName),
    cliPath: path.join(fixtureScripts, cliName),
  };
}

function runLauncher(fixture, { input = dummyUrl, args = [], timeout = 30_000 } = {}) {
  const hostPath = path.join(fixture.root, `transport-host-${hostSequence++}.ps1`);
  const argumentText = args.map(quotePowerShell).join(" ");
  writeFileSync(
    hostPath,
    `$fixedInput = ${quotePowerShell(input)}
function Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  if (-not $AsSecureString) { throw "fixed test input unavailable" }
  return ConvertTo-SecureString -String $fixedInput -AsPlainText -Force
}
& ${quotePowerShell(fixture.launcherPath)} ${argumentText}
exit $LASTEXITCODE
`
  );
  return spawnSync(
    fixedPowerShellPath,
    ["-NoLogo", "-NoProfile", "-File", hostPath],
    {
      cwd: fixture.root,
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      encoding: "utf8",
      timeout,
      windowsHide: true,
    }
  );
}

function assertResult(result, classification, exitCode) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, exitCode);
  assert.deepEqual(result.stdout.split(/\r?\n/), [classification, ""]);
  assert.equal(result.stderr, "");
  for (const forbidden of [dummyUrl, selectedAddress, rawSentinel]) {
    assert.equal(result.stdout.includes(forbidden), false);
    assert.equal(result.stderr.includes(forbidden), false);
  }
}

function fixedChildSource(classification, exitCode, extra = "") {
  return `
import { writeFileSync } from "node:fs";
${extra}
const expectedNames = ["UPSTASH_REDIS_REST_URL"];
const actualNames = Object.keys(process.env).sort();
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames) || process.env.UPSTASH_REDIS_REST_URL !== ${JSON.stringify(dummyUrl)} || process.argv.some((value) => value.includes(${JSON.stringify(dummyUrl)}))) {
  process.stdout.write("FIXTURE_BOUNDARY_MISMATCH\\n");
  process.exitCode = 98;
} else {
  process.stdout.write(${JSON.stringify(`${classification}\n`)});
  process.exitCode = ${exitCode};
}
`;
}

assert.equal(existsSync(fixedPowerShellPath), true);

try {
  for (const [classification, exitCode] of resultMap) {
    const fixture = await createFixture({
      cliSource: fixedChildSource(classification, exitCode),
    });
    assertResult(runLauncher(fixture), classification, exitCode);
  }

  {
    const fixture = await createFixture({
      cliSource: fixedChildSource("PASS_TRANSPORT_TLS", 0),
    });
    assertResult(
      runLauncher(fixture, { args: ["--unexpected"], input: "" }),
      "STOP_RUNTIME_BOUNDARY",
      13
    );
  }

  for (const invalidInput of [
    "",
    " ",
    ` ${dummyUrl}`,
    `${dummyUrl} `,
    `${dummyUrl}\r`,
    `${dummyUrl}\n`,
    `UPSTASH_REDIS_REST_URL=${dummyUrl}`,
    `"${dummyUrl}"`,
    `'${dummyUrl}'`,
    "http://transport-launcher.invalid",
    "https://user@transport-launcher.invalid",
    "https://user:pass@transport-launcher.invalid",
    "https://transport-launcher.invalid?query=1",
    "https://transport-launcher.invalid#fragment",
    "https://transport-launcher.invalid:444",
  ]) {
    const markerPath = path.join(os.tmpdir(), `transport-marker-${hostSequence}.txt`);
    const fixture = await createFixture({
      cliSource: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "started"); process.stdout.write("PASS_TRANSPORT_TLS\\n"); process.exitCode = 0;\n`,
    });
    assertResult(
      runLauncher(fixture, { input: invalidInput }),
      "STOP_RUNTIME_BOUNDARY",
      13
    );
    assert.equal(existsSync(markerPath), false);
  }

  for (const cliSource of [
    `process.stderr.write(${JSON.stringify(rawSentinel)}); process.stdout.write("PASS_TRANSPORT_TLS\\n"); process.exitCode = 0;\n`,
    'process.stdout.write("PASS_TRANSPORT_TLS\\r\\n"); process.exitCode = 0;\n',
    'process.stdout.write("PASS_TRANSPORT_TLS"); process.exitCode = 0;\n',
    'process.stdout.write("PASS_TRANSPORT_TLS\\nEXTRA\\n"); process.exitCode = 0;\n',
    'process.stdout.write("UNKNOWN_TRANSPORT\\n"); process.exitCode = 0;\n',
    'process.stdout.write("PASS_TRANSPORT_TLS\\n"); process.exitCode = 41;\n',
  ]) {
    const fixture = await createFixture({ cliSource });
    assertResult(
      runLauncher(fixture),
      wrapperResult.classification,
      wrapperResult.exitCode
    );
  }

  {
    const shortened = launcherSource.replace(
      "$PROCESS_WATCHDOG_MS = 180000",
      "$PROCESS_WATCHDOG_MS = 200"
    );
    const fixture = await createFixture({
      source: shortened,
      cliSource: "setInterval(() => {}, 1000);\n",
    });
    assertResult(
      runLauncher(fixture, { timeout: 10_000 }),
      wrapperResult.classification,
      wrapperResult.exitCode
    );
  }

  {
    const fixture = await createFixture({
      cliSource: await readFile(path.join(scriptsRoot, cliName), "utf8"),
    });
    const auditPath = path.join(fixture.root, "full-path-audit.json");
    await writeFile(
      auditPath,
      JSON.stringify({ lookupCalls: 0, socketCount: 0, destroyCalls: 0, boundary: false })
    );
    const dnsPath = path.join(fixture.root, "scripts", "fake-dns.mjs");
    const tlsPath = path.join(fixture.root, "scripts", "fake-tls.mjs");
    await writeFile(
      dnsPath,
      `import { readFileSync, writeFileSync } from "node:fs";
const p = ${JSON.stringify(auditPath)};
export function lookup(hostname, options, callback) {
  const a = JSON.parse(readFileSync(p, "utf8"));
  a.lookupCalls += 1;
  a.boundary = hostname === "transport-launcher.invalid" && options?.all === false && options?.verbatim === true && JSON.stringify(Object.keys(process.env).sort()) === JSON.stringify(["UPSTASH_REDIS_REST_URL"]);
  writeFileSync(p, JSON.stringify(a));
  queueMicrotask(() => callback(null, ${JSON.stringify(selectedAddress)}, 4));
}
`
    );
    await writeFile(
      tlsPath,
      `import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
const p = ${JSON.stringify(auditPath)};
export function connect(options) {
  const a = JSON.parse(readFileSync(p, "utf8"));
  a.socketCount += 1;
  a.boundary = a.boundary && options?.host === ${JSON.stringify(selectedAddress)} && options?.servername === "transport-launcher.invalid" && options?.port === 443 && options?.rejectUnauthorized === true && typeof options?.lookup === "function";
  writeFileSync(p, JSON.stringify(a));
  const socket = new EventEmitter();
  socket.destroy = () => { const n = JSON.parse(readFileSync(p, "utf8")); n.destroyCalls += 1; writeFileSync(p, JSON.stringify(n)); queueMicrotask(() => socket.emit("close")); };
  queueMicrotask(() => { socket.emit("connect"); socket.emit("secureConnect"); });
  return socket;
}
`
    );
    await writeFile(
      path.join(fixture.root, "scripts", loaderName),
      `const dnsUrl = ${JSON.stringify(pathToFileURL(dnsPath).href)};
const tlsUrl = ${JSON.stringify(pathToFileURL(tlsPath).href)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:dns") return { url: dnsUrl, shortCircuit: true };
  if (specifier === "node:tls") return { url: tlsUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
`
    );
    assertResult(runLauncher(fixture), "PASS_TRANSPORT_TLS", 0);
    const audit = JSON.parse(await readFile(auditPath, "utf8"));
    assert.deepEqual(audit, {
      lookupCalls: 1,
      socketCount: 1,
      destroyCalls: 1,
      boundary: true,
    });
  }
} finally {
  for (const root of temporaryRoots) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("upstash-transport-launcher-"));
    await rm(root, { recursive: true, force: true });
  }
}

process.stdout.write("Upstash transport launcher tests passed\n");

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
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const scriptsRoot = path.join(repositoryRoot, "scripts");
const fixedNodePath = "C:\\Program Files\\nodejs\\node.exe";
const cliName = "probe-upstash-transport.mjs";
const loaderName = "upstash-transport-cli-loader.mjs";
const dummyUrl = "https://transport-probe.invalid";
const selectedAddress = "192.0.2.40";
const rawSentinel = "RAW_TRANSPORT_DETAIL_MUST_NOT_SURFACE";
const auditName = "transport-audit.json";
const temporaryRoots = [];

function fakeDnsSource(auditPath, scenario) {
  return `
import { readFileSync, writeFileSync } from "node:fs";
const auditPath = ${JSON.stringify(auditPath)};
const readAudit = () => JSON.parse(readFileSync(auditPath, "utf8"));
const save = (audit) => writeFileSync(auditPath, JSON.stringify(audit));
export function lookup(hostname, options, callback) {
  const audit = readAudit();
  audit.lookupCalls += 1;
  audit.lookupMatched = hostname === "transport-probe.invalid";
  audit.lookupOptions = {
    all: options?.all,
    verbatim: options?.verbatim,
  };
  save(audit);
  ${scenario === "dns-failure" ? `queueMicrotask(() => callback(new Error(${JSON.stringify(rawSentinel)})));` : `queueMicrotask(() => callback(null, ${JSON.stringify(selectedAddress)}, 4));`}
}
`;
}

function fakeTlsSource(auditPath, scenario) {
  return `
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
const auditPath = ${JSON.stringify(auditPath)};
const readAudit = () => JSON.parse(readFileSync(auditPath, "utf8"));
const save = (audit) => writeFileSync(auditPath, JSON.stringify(audit));
export function connect(options) {
  const audit = readAudit();
  audit.socketCount += 1;
  audit.socketOptions = {
    hostMatched: options?.host === ${JSON.stringify(selectedAddress)},
    servernameMatched: options?.servername === "transport-probe.invalid",
    port: options?.port,
    rejectUnauthorized: options?.rejectUnauthorized,
    hasLookupTripwire: typeof options?.lookup === "function",
  };
  save(audit);
  ${scenario === "connect-throws" ? `throw new Error(${JSON.stringify(rawSentinel)});` : ""}
  const socket = new EventEmitter();
  socket.destroy = () => {
    const next = readAudit();
    next.destroyCalls += 1;
    save(next);
    queueMicrotask(() => socket.emit("close"));
  };
  ${scenario === "listener-failure" ? `socket.once = () => { throw new Error(${JSON.stringify(rawSentinel)}); };` : ""}
  ${scenario === "success" ? `queueMicrotask(() => { socket.emit("connect"); socket.emit("secureConnect"); });` : ""}
  ${scenario === "tcp-failure" ? `queueMicrotask(() => socket.emit("error", new Error(${JSON.stringify(rawSentinel)})));` : ""}
  ${scenario === "tls-failure" ? `queueMicrotask(() => { socket.emit("connect"); socket.emit("error", new Error(${JSON.stringify(rawSentinel)})); });` : ""}
  ${scenario === "tcp-close" ? `queueMicrotask(() => socket.emit("close"));` : ""}
  ${scenario === "tls-close" ? `queueMicrotask(() => { socket.emit("connect"); socket.emit("close"); });` : ""}
  return socket;
}
`;
}

async function createFixture(scenario) {
  const root = await mkdtemp(path.join(os.tmpdir(), "upstash-transport-test-"));
  temporaryRoots.push(root);
  const fixtureScripts = path.join(root, "scripts");
  await mkdir(fixtureScripts);
  await copyFile(path.join(scriptsRoot, cliName), path.join(fixtureScripts, cliName));
  const auditPath = path.join(root, auditName);
  await writeFile(
    auditPath,
    JSON.stringify({
      lookupCalls: 0,
      lookupMatched: false,
      lookupOptions: null,
      socketCount: 0,
      socketOptions: null,
      destroyCalls: 0,
    })
  );
  await writeFile(
    path.join(fixtureScripts, "fake-dns.mjs"),
    fakeDnsSource(auditPath, scenario)
  );
  await writeFile(
    path.join(fixtureScripts, "fake-tls.mjs"),
    fakeTlsSource(auditPath, scenario)
  );
  await writeFile(
    path.join(fixtureScripts, loaderName),
    `
const dnsUrl = ${JSON.stringify(pathToFileURL(path.join(fixtureScripts, "fake-dns.mjs")).href)};
const tlsUrl = ${JSON.stringify(pathToFileURL(path.join(fixtureScripts, "fake-tls.mjs")).href)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:dns") return { url: dnsUrl, shortCircuit: true };
  if (specifier === "node:tls") return { url: tlsUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
`
  );
  return { root, auditPath };
}

assert.equal(existsSync(fixedNodePath), true);

try {
  for (const [scenario, classification, exitCode] of [
    ["success", "PASS_TRANSPORT_TLS", 0],
    ["dns-failure", "STOP_TRANSPORT_DNS", 40],
    ["tcp-failure", "STOP_TRANSPORT_TCP", 41],
    ["tcp-close", "STOP_TRANSPORT_TCP", 41],
    ["tls-failure", "STOP_TRANSPORT_TLS", 42],
    ["tls-close", "STOP_TRANSPORT_TLS", 42],
    ["timeout", "STOP_TRANSPORT_TIMEOUT", 43],
    ["connect-throws", "STOP_TRANSPORT_INDETERMINATE", 44],
    ["listener-failure", "STOP_TRANSPORT_INDETERMINATE", 44],
  ]) {
    const fixture = await createFixture(scenario);
    const result = spawnSync(
      fixedNodePath,
      [
        "--no-warnings",
        "--experimental-loader",
        "./scripts/upstash-transport-cli-loader.mjs",
        "./scripts/probe-upstash-transport.mjs",
        "--confirm-fixed-transport",
      ],
      {
        cwd: fixture.root,
        env: { UPSTASH_REDIS_REST_URL: dummyUrl },
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      }
    );
    const audit = JSON.parse(await readFile(fixture.auditPath, "utf8"));
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(
      result.status,
      exitCode,
      JSON.stringify({ scenario, stdout: result.stdout, stderr: result.stderr, audit })
    );
    assert.equal(result.stdout, `${classification}\n`);
    assert.equal(result.stderr, "");
    for (const forbidden of [dummyUrl, selectedAddress, rawSentinel]) {
      assert.equal(result.stdout.includes(forbidden), false);
      assert.equal(result.stderr.includes(forbidden), false);
    }
    assert.equal(audit.lookupCalls, 1);
    assert.equal(audit.lookupMatched, true);
    assert.deepEqual(audit.lookupOptions, { all: false, verbatim: true });
    const expectsSocket = scenario !== "dns-failure";
    assert.equal(audit.socketCount, expectsSocket ? 1 : 0);
    if (expectsSocket) {
      assert.deepEqual(audit.socketOptions, {
        hostMatched: true,
        servernameMatched: true,
        port: 443,
        rejectUnauthorized: true,
        hasLookupTripwire: true,
      });
    }
    const expectsDestroy = expectsSocket && scenario !== "connect-throws";
    assert.equal(audit.destroyCalls, expectsDestroy ? 1 : 0);
  }

  const cliSource = await readFile(path.join(scriptsRoot, cliName), "utf8");
  assert.equal(cliSource.includes("socket.write"), false);
  assert.equal(/\bfetch\b/.test(cliSource), false);
  assert.equal(/node:https?|node:http2/.test(cliSource), false);
  assert.equal(/@upstash|\.get\(|\.set\(|\.del\(|\.eval\(|\.pipeline\(|\bKEYS\b|\bSCAN\b/i.test(cliSource), false);
  assert.equal(/TOKEN/i.test(cliSource), false);
} finally {
  for (const root of temporaryRoots) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("upstash-transport-test-"));
    await rm(root, { recursive: true, force: true });
  }
}

process.stdout.write("Upstash transport probe tests passed\n");

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import {
  assertLoopbackPortAvailable,
  createMockEnvironment,
  installTtyEtxHandler,
  startOwnedProcess,
  waitForLoopbackPort,
} from "./mock-dev-runner.mjs";

const START_TIMEOUT_MS = 25_000;
const RELEASE_TIMEOUT_MS = 8_000;
const forceOnly = process.argv.includes("--force-only");
const gracefulOnly = process.argv.includes("--graceful-only");

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

class FakeTty extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;

  isPaused() {
    return this.paused;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  setRawMode(value) {
    this.isRaw = value;
  }
}

const fakeTty = new FakeTty();
const forwarded = [];
let etxCount = 0;
const etx = installTtyEtxHandler({
  stdin: fakeTty,
  childStdin: {
    destroyed: false,
    write(value) {
      forwarded.push(value);
    },
  },
  onEtx() {
    etxCount += 1;
  },
});
assert.equal(etx.installed, true);
assert.equal(fakeTty.isRaw, true);
assert.equal(fakeTty.isPaused(), false);
fakeTty.emit("data", Buffer.from([65, 3, 66]));
assert.equal(etxCount, 1);
assert.equal(Buffer.concat(forwarded).toString("utf8"), "AB");
etx.restore();
assert.equal(fakeTty.isRaw, false);
assert.equal(fakeTty.isPaused(), true);
assert.equal(fakeTty.listenerCount("data"), 0);

const nonTty = installTtyEtxHandler({
  stdin: { isTTY: false },
  childStdin: {},
  onEtx() {},
});
assert.equal(nonTty.installed, false);

function sendMessage(child, message) {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sendConsecutiveSignals(child, signal) {
  let onMessage;
  return withTimeout(
    new Promise((resolve, reject) => {
      onMessage = (message) => {
        if (
          message?.type !==
            "mock-runner-test-consecutive-signals-result" ||
          message.signal !== signal
        ) {
          return;
        }
        child.removeListener("message", onMessage);
        resolve(message);
      };
      child.on("message", onMessage);
      child.send(
        { type: "mock-runner-test-consecutive-signals", signal },
        (error) => {
          if (!error) return;
          child.removeListener("message", onMessage);
          reject(error);
        }
      );
    }),
    15_000,
    `mock runner did not acknowledge consecutive ${signal}`
  ).finally(() => child.removeListener("message", onMessage));
}

async function cleanupFailedCase(controller) {
  if (!controller || controller.hasExited()) return;
  try {
    await controller.stop({ signal: "SIGTERM" });
  } catch (error) {
    controller.unref();
    console.error(
      "Lifecycle test could not verify or collect its own child; no port-based cleanup was attempted:",
      error
    );
  }
}

async function testRunnerSignal(signal, expectedExitCode) {
  await assertLoopbackPortAvailable(3000);
  const env = createMockEnvironment();
  env.MOCK_RUNNER_LIFECYCLE_TEST = "1";
  let controller = null;
  let completed = false;
  try {
    controller = await startOwnedProcess({
      command: process.execPath,
      args: [path.join(process.cwd(), "scripts", "run-mock-dev.mjs")],
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      port: 3000,
      gracefulTimeoutMs: 20_000,
      forceTimeoutMs: 8_000,
    });
    assert.equal(controller.identity.parentPid, process.pid);
    if (process.platform === "win32") {
      assert.equal(controller.identity.osParentPid, process.pid);
      assert.match(controller.identity.osStartedAt, /^\d+$/);
    }

    assert.equal(
      await waitForLoopbackPort(3000, true, START_TIMEOUT_MS),
      true,
      `mock runner did not start for ${signal}`
    );
    const result = await controller.stop({
      requestShutdown: (child) =>
        sendMessage(child, { type: "mock-runner-test-signal", signal }),
    });
    completed = true;
    assert.equal(result.cleanup, "graceful");
    assert.equal(result.code, expectedExitCode);
    assert.equal(
      await waitForLoopbackPort(3000, false, RELEASE_TIMEOUT_MS),
      true
    );
    console.log(`mock runner ${signal} test passed (${result.cleanup})`);
  } finally {
    if (!completed) await cleanupFailedCase(controller);
  }
}

async function testConsecutiveRunnerSignals(signal, expectedExitCode) {
  await assertLoopbackPortAvailable(3000);
  const env = createMockEnvironment();
  env.MOCK_RUNNER_LIFECYCLE_TEST = "1";
  let controller = null;
  let completed = false;
  try {
    controller = await startOwnedProcess({
      command: process.execPath,
      args: [path.join(process.cwd(), "scripts", "run-mock-dev.mjs")],
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      port: 3000,
      gracefulTimeoutMs: 20_000,
      forceTimeoutMs: 8_000,
    });
    assert.equal(
      await waitForLoopbackPort(3000, true, START_TIMEOUT_MS),
      true,
      `mock runner did not start for consecutive ${signal}`
    );

    let observation = null;
    const result = await controller.stop({
      requestShutdown: async (child) => {
        observation = await sendConsecutiveSignals(child, signal);
      },
    });
    completed = true;
    assert.deepEqual(observation?.listenerCounts, [1, 1]);
    assert.equal(result.cleanup, "graceful");
    assert.equal(result.code, expectedExitCode);
    assert.equal(
      await waitForLoopbackPort(3000, false, RELEASE_TIMEOUT_MS),
      true
    );
    console.log(`mock runner consecutive ${signal} test passed`);
  } finally {
    if (!completed) await cleanupFailedCase(controller);
  }
}

if (!forceOnly) {
  await testRunnerSignal("SIGINT", 130);
  await testRunnerSignal("SIGTERM", 143);
  await testConsecutiveRunnerSignals("SIGINT", 130);
  await testConsecutiveRunnerSignals("SIGTERM", 143);
}

if (!gracefulOnly) {
  await assertLoopbackPortAvailable(3000);
  let stubbornController = null;
  let stubbornStopped = false;
  try {
    stubbornController = await startOwnedProcess({
      command: process.execPath,
      args: [
        path.join(process.cwd(), "scripts", "mock-dev-stubborn-fixture.mjs"),
      ],
      cwd: process.cwd(),
      env: createMockEnvironment(),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      port: 3000,
      gracefulTimeoutMs: 1_000,
      forceTimeoutMs: 20_000,
    });
    assert.equal(
      await waitForLoopbackPort(3000, true, START_TIMEOUT_MS),
      true,
      "stubborn fixture did not start"
    );
    const result = await stubbornController.stop({
      requestShutdown: (child) => sendMessage(child, { type: "shutdown" }),
    });
    stubbornStopped = true;
    assert.equal(result.cleanup, "forced_owned_tree");
    assert.equal(
      await waitForLoopbackPort(3000, false, RELEASE_TIMEOUT_MS),
      true
    );
    console.log("owned PID tree force fallback test passed");
  } finally {
    if (!stubbornStopped) await cleanupFailedCase(stubbornController);
  }
}

if (!forceOnly) {
  const existingListener = net.createServer((socket) => socket.end());
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        existingListener.once("error", reject);
        existingListener.listen(3000, "127.0.0.1", resolve);
      }),
      2_000,
      "test-owned listener did not start within the timeout"
    );
    await assert.rejects(
      () => assertLoopbackPortAvailable(3000),
      /already has a listener\. No process was started or stopped/
    );
    assert.equal(existingListener.listening, true);
  } finally {
    if (existingListener.listening) {
      await withTimeout(
        new Promise((resolve) => existingListener.close(resolve)),
        2_000,
        "test-owned listener did not stop within the timeout"
      );
    }
  }
  console.log("existing listener safety test passed");
}

assert.equal(
  await waitForLoopbackPort(3000, false, RELEASE_TIMEOUT_MS),
  true
);

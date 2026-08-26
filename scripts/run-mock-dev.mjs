import {
  assertLoopbackPortAvailable,
  attachInteractiveEtx,
  startMockDevServer,
  waitForLoopbackPort,
} from "./mock-dev-runner.mjs";

let activeController = null;

async function run() {
  await assertLoopbackPortAvailable(3000);

  const controller = await startMockDevServer({ interactiveInput: true });
  activeController = controller;
  let shutdownPromise = null;
  let requestedExitCode = null;
  let input = { restore() {} };

  const restoreInput = () => {
    try {
      input.restore();
    } catch (error) {
      console.error("mock runner could not restore stdin state:", error);
      requestedExitCode = 1;
      process.exitCode = 1;
    }
  };

  const shutdown = (reason, signal, exitCode) => {
    if (shutdownPromise) return shutdownPromise;
    requestedExitCode = exitCode;
    restoreInput();
    shutdownPromise = (async () => {
      try {
        await controller.stop({ signal });
        const released = await waitForLoopbackPort(3000, false, 3_000);
        if (!released) {
          throw new Error(
            `PID ${controller.identity.childPid} exited, but 127.0.0.1:3000 is still listening. No process was targeted by port.`
          );
        }
      } catch (error) {
        console.error(`mock runner cleanup failed after ${reason}:`, error);
        controller.unref();
        requestedExitCode = 1;
      }
    })();
    return shutdownPromise;
  };

  const onSigint = () => void shutdown("SIGINT", "SIGINT", 130);
  const onSigterm = () => void shutdown("SIGTERM", "SIGTERM", 143);
  const onUncaughtException = (error) => {
    console.error("mock runner uncaught exception:", error);
    void shutdown("uncaughtException", "SIGTERM", 1);
  };
  const onUnhandledRejection = (reason) => {
    console.error("mock runner unhandled rejection:", reason);
    void shutdown("unhandledRejection", "SIGTERM", 1);
  };
  const onTestMessage = (message) => {
    if (
      process.env.MOCK_RUNNER_LIFECYCLE_TEST === "1" &&
      message?.type === "mock-runner-test-signal" &&
      (message.signal === "SIGINT" || message.signal === "SIGTERM")
    ) {
      process.emit(message.signal);
    }
  };

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("uncaughtException", onUncaughtException);
  process.once("unhandledRejection", onUnhandledRejection);
  if (typeof process.send === "function") process.on("message", onTestMessage);
  input = attachInteractiveEtx(controller, () =>
    void shutdown("TTY ETX", "SIGINT", 130)
  );

  try {
    const result = await controller.exited;
    if (shutdownPromise) await shutdownPromise;
    else {
      const released = await waitForLoopbackPort(3000, false, 3_000);
      if (!released) {
        console.error(
          `Child PID ${controller.identity.childPid} exited unexpectedly, but 127.0.0.1:3000 is still listening. No process was targeted by port.`
        );
        requestedExitCode = 1;
      }
    }
    process.exitCode =
      requestedExitCode ?? result.code ?? (result.signal === null ? 0 : 1);
  } finally {
    restoreInput();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("uncaughtException", onUncaughtException);
    process.removeListener("unhandledRejection", onUnhandledRejection);
    process.removeListener("message", onTestMessage);
  }
}

run().catch(async (error) => {
  console.error(error);
  if (activeController && !activeController.hasExited()) {
    try {
      await activeController.stop({ signal: "SIGTERM" });
    } catch (cleanupError) {
      activeController.unref();
      console.error(
        "mock runner top-level cleanup could not verify or stop its owned child:",
        cleanupError
      );
    }
  }
  process.exitCode = 1;
});

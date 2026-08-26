import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_GRACEFUL_TIMEOUT_MS = 5_000;
// Windowsではtaskkill完了後もprocess tableとsocket解放の反映に数秒を
// 要する場合がある。強制対象を広げず、同じ所有PIDだけを長めに確認する。
const DEFAULT_FORCE_TIMEOUT_MS = 20_000;
const WINDOWS_SNAPSHOT_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "windows-process-snapshot.ps1"
);

const SECRET_ENV_NAMES = [
  "BASE_API_TOKEN",
  "BASE_API_REFRESH_TOKEN",
  "BASE_API_BASE_URL",
  "BASE_CHECK_ORDER_UNIQUE_KEY",
  "BASE_READONLY_ACCESS_TOKEN",
  "BASE_READONLY_CLIENT_ID",
  "BASE_READONLY_CLIENT_SECRET",
  "BASE_READONLY_REDIRECT_URI",
  "BASE_CLIENT_ID",
  "BASE_CLIENT_SECRET",
  "BASE_REDIRECT_URI",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

export function createMockEnvironment(source = process.env) {
  const env = { ...source };
  for (const name of SECRET_ENV_NAMES) delete env[name];
  delete env.MOCK_RUNNER_LIFECYCLE_TEST;

  return Object.assign(env, {
    APP_ENVIRONMENT: "local",
    BASE_DATA_MODE: "mock",
    APP_STORE_MODE: "memory",
    ADMIN_USERNAME: "mock-admin",
    ADMIN_PASSWORD: "mock-local-only",
    NEXTAUTH_SECRET: "mock-local-nextauth-secret-not-for-shared-use",
    NEXTAUTH_URL: "http://127.0.0.1:3000",
    RECEIPT_SHARE_SECRET: "mock-local-receipt-secret-not-for-shared-use",
    NEXT_TELEMETRY_DISABLED: "1",
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function isLoopbackPortListening(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;

    const finish = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(true));
  });
}

export async function assertLoopbackPortAvailable(port) {
  if (await isLoopbackPortListening(port)) {
    throw new Error(
      `127.0.0.1:${port} already has a listener. No process was started or stopped.`
    );
  }
}

export async function waitForLoopbackPort(
  port,
  expectedListening,
  timeoutMs
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isLoopbackPortListening(port)) === expectedListening) return true;
    await wait(100);
  }
  return (await isLoopbackPortListening(port)) === expectedListening;
}

function queryWindowsProcesses({ rootPid, processIds, timeoutMs = 6_000 }) {
  if (process.platform !== "win32") return null;

  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    WINDOWS_SNAPSHOT_SCRIPT,
  ];
  if (rootPid !== undefined) {
    args.push("-RootProcessId", String(rootPid));
  } else {
    args.push("-ProcessIdCsv", processIds.join(","));
  }

  const result = spawnSync("powershell.exe", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.status !== 0) return null;

  try {
    const parsed = JSON.parse(result.stdout.trim());
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter(
        (entry) =>
          Number.isInteger(entry.processId) &&
          Number.isInteger(entry.parentProcessId)
      )
      .map((entry) => ({
        processId: entry.processId,
        parentProcessId: entry.parentProcessId,
        startedAt:
          typeof entry.startedAt === "string" ? entry.startedAt : null,
      }));
  } catch {
    return null;
  }
}

function waitForChildExit(exitPromise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resolve({ exited: false, result: null }),
      timeoutMs
    );
    exitPromise.then(
      (result) => {
        clearTimeout(timer);
        resolve({ exited: true, result });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function installTtyEtxHandler({ stdin, childStdin, onEtx }) {
  if (
    !stdin?.isTTY ||
    typeof stdin.setRawMode !== "function" ||
    !childStdin
  ) {
    return { installed: false, restore() {} };
  }

  const wasPaused = stdin.isPaused();
  const wasRaw = Boolean(stdin.isRaw);
  let rawModeChanged = false;
  let restored = false;

  const restoreState = () => {
    if (restored) return;
    restored = true;
    stdin.removeListener("data", onData);
    let restoreError = null;
    try {
      if (rawModeChanged) stdin.setRawMode(wasRaw);
    } catch (error) {
      restoreError = error;
    }
    try {
      if (wasPaused) stdin.pause();
    } catch (error) {
      restoreError ??= error;
    }
    if (restoreError) throw restoreError;
  };

  const onData = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const forwarded = [];
    for (const byte of bytes) {
      if (byte === 3) onEtx();
      else forwarded.push(byte);
    }
    if (forwarded.length > 0 && !childStdin.destroyed) {
      childStdin.write(Buffer.from(forwarded));
    }
  };

  try {
    if (!wasRaw) {
      stdin.setRawMode(true);
      rawModeChanged = true;
    }
    stdin.on("data", onData);
    stdin.resume();
  } catch (error) {
    try {
      if (rawModeChanged) stdin.setRawMode(wasRaw);
    } catch {
      // 元のstdin状態への復元を試みた後、ETX捕捉を無効にする。
    }
    try {
      if (wasPaused) stdin.pause();
    } catch {
      // raw modeとは独立して、元のpause状態への復元も試みる。
    }
    return { installed: false, error, restore() {} };
  }

  return { installed: true, restore: restoreState };
}

function captureOwnedWindowsTree(identity) {
  const snapshot = queryWindowsProcesses({ rootPid: identity.childPid });
  if (!snapshot) {
    return { verified: false, reason: "Windows process snapshot failed" };
  }

  const root = snapshot.find((entry) => entry.processId === identity.childPid);
  if (!root || root.parentProcessId !== identity.parentPid) {
    return {
      verified: false,
      reason: "direct child PID and OS parent relationship did not match",
    };
  }
  if (
    identity.osStartedAt !== null &&
    root.startedAt !== identity.osStartedAt
  ) {
    return { verified: false, reason: "direct child start time did not match" };
  }

  return { verified: true, processes: snapshot };
}

function findRemainingOwnedProcesses(ownedProcesses) {
  const current = queryWindowsProcesses({
    processIds: ownedProcesses.map((entry) => entry.processId),
  });
  if (!current) {
    return { verified: false, reason: "current process snapshot failed" };
  }

  const currentByPid = new Map(
    current.map((entry) => [entry.processId, entry])
  );
  const remaining = [];
  for (const owned of ownedProcesses) {
    const entry = currentByPid.get(owned.processId);
    if (!entry) continue;
    if (owned.startedAt === null || entry.startedAt === null) {
      return {
        verified: false,
        reason: `start time unavailable for PID ${owned.processId}`,
      };
    }
    if (owned.startedAt === entry.startedAt) remaining.push(owned);
  }
  return { verified: true, remaining };
}

async function waitForOwnedWindowsProcessesExit(ownedProcesses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = findRemainingOwnedProcesses(ownedProcesses);
  while (
    state.verified &&
    state.remaining.length > 0 &&
    Date.now() < deadline
  ) {
    await wait(Math.min(100, Math.max(0, deadline - Date.now())));
    state = findRemainingOwnedProcesses(ownedProcesses);
  }
  return state;
}

function forceOwnedWindowsProcesses(ownedProcesses, timeoutMs) {
  const state = findRemainingOwnedProcesses(ownedProcesses);
  if (!state.verified) {
    throw new Error(`Refusing forced cleanup: ${state.reason}.`);
  }

  const remainingPids = new Set(
    state.remaining.map((entry) => entry.processId)
  );
  const remainingRoots = state.remaining.filter(
    (entry) => !remainingPids.has(entry.parentProcessId)
  );
  const failures = [];
  for (const root of remainingRoots) {
    const result = spawnSync(
      "taskkill.exe",
      ["/PID", String(root.processId), "/T", "/F"],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true }
    );
    if (result.error || result.status !== 0) {
      failures.push(
        `PID ${root.processId}: ${result.error?.message ?? `exit ${result.status}`} ${result.stderr?.trim() ?? ""}`.trim()
      );
    }
  }
  if (failures.length > 0) {
    const afterAttempt = findRemainingOwnedProcesses(ownedProcesses);
    if (!afterAttempt.verified || afterAttempt.remaining.length > 0) {
      throw new Error(
        `Forced cleanup command failed for the verified owned process tree (${failures.join("; ")}). No process was targeted by port.`
      );
    }
  }
  return remainingRoots.length > 0;
}

export async function startOwnedProcess({
  command,
  args,
  cwd = process.cwd(),
  env = process.env,
  stdio = "inherit",
  port = 3000,
  detached = process.platform !== "win32",
  gracefulTimeoutMs = DEFAULT_GRACEFUL_TIMEOUT_MS,
  forceTimeoutMs = DEFAULT_FORCE_TIMEOUT_MS,
} = {}) {
  const child = spawn(command, args, { cwd, env, detached, stdio });

  let resolveExit;
  let rejectExit;
  const exited = new Promise((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
  child.once("error", rejectExit);

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const initialWindowsSnapshot = queryWindowsProcesses({ rootPid: child.pid });
  const initialWindowsRoot = initialWindowsSnapshot?.find(
    (entry) => entry.processId === child.pid
  );
  const identity = Object.freeze({
    childPid: child.pid,
    parentPid: process.pid,
    spawnedAt: new Date().toISOString(),
    osParentPid: initialWindowsRoot?.parentProcessId ?? null,
    osStartedAt: initialWindowsRoot?.startedAt ?? null,
  });
  let stopPromise = null;

  const controller = {
    child,
    exited,
    identity,
    hasExited() {
      return child.exitCode !== null || child.signalCode !== null;
    },
    unref() {
      child.stdin?.destroy();
      child.unref();
    },
    stop({ signal = "SIGTERM", requestShutdown } = {}) {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (controller.hasExited()) {
          const released = await waitForLoopbackPort(
            port,
            false,
            gracefulTimeoutMs
          );
          if (!released) {
            throw new Error(
              `Direct child already exited, but 127.0.0.1:${port} is still listening. No process was targeted by port.`
            );
          }
          return { ...(await exited), cleanup: "already_exited" };
        }

        const ownedWindowsTree =
          process.platform === "win32"
            ? captureOwnedWindowsTree(identity)
            : null;
        const gracefulDeadline = Date.now() + gracefulTimeoutMs;
        if (requestShutdown) await requestShutdown(child);
        else child.kill(signal);
        const graceful = await waitForChildExit(
          exited,
          Math.max(0, gracefulDeadline - Date.now())
        );
        const released = await waitForLoopbackPort(
          port,
          false,
          Math.max(0, gracefulDeadline - Date.now())
        );
        const remaining = ownedWindowsTree?.verified
          ? findRemainingOwnedProcesses(ownedWindowsTree.processes)
          : null;
        const ownedProcessesGone =
          process.platform !== "win32" ||
          (remaining?.verified && remaining.remaining.length === 0);

        if (graceful.exited && released && ownedProcessesGone) {
          return { ...graceful.result, cleanup: "graceful" };
        }

        if (process.platform === "win32") {
          if (!ownedWindowsTree?.verified) {
            throw new Error(
              `Refusing forced cleanup: ${ownedWindowsTree?.reason ?? "owned process tree was not captured"}. No process was targeted by port.`
            );
          }
          if (!remaining?.verified) {
            throw new Error(
              `Refusing forced cleanup: ${remaining?.reason ?? "remaining owned processes could not be verified"}. No process was targeted by port.`
            );
          }
          if (remaining.remaining.length === 0) {
            throw new Error(
              `Runner-owned processes exited, but 127.0.0.1:${port} is still listening. No process was targeted by port.`
            );
          }
          forceOwnedWindowsProcesses(
            ownedWindowsTree.processes,
            forceTimeoutMs
          );
        } else {
          process.kill(-identity.childPid, "SIGKILL");
        }

        // OSのprocess table更新、Nodeのexit event、port解放を同じ制限時間で
        // 並行確認し、前の確認が時間を使い切って後続を誤失敗させない。
        const [forced, forceReleased, afterForce] = await Promise.all([
          graceful.exited
            ? graceful
            : waitForChildExit(exited, forceTimeoutMs),
          waitForLoopbackPort(port, false, forceTimeoutMs),
          ownedWindowsTree?.verified
            ? waitForOwnedWindowsProcessesExit(
                ownedWindowsTree.processes,
                forceTimeoutMs
              )
            : null,
        ]);
        if (
          !forced.exited ||
          !forceReleased ||
          (process.platform === "win32" &&
            (!afterForce?.verified || afterForce.remaining.length > 0))
        ) {
          throw new Error(
            `Runner-owned process tree did not fully exit within the cleanup timeout (childExited=${forced.exited}, portReleased=${forceReleased}, processSnapshotVerified=${afterForce?.verified ?? false}, remainingOwned=${afterForce?.remaining?.length ?? "unknown"}). No process was targeted by port.`
          );
        }
        return { ...forced.result, cleanup: "forced_owned_tree" };
      })();
      return stopPromise;
    },
  };

  return controller;
}

export async function startMockDevServer({
  cwd = process.cwd(),
  env = createMockEnvironment(),
  interactiveInput = false,
  gracefulTimeoutMs = DEFAULT_GRACEFUL_TIMEOUT_MS,
  forceTimeoutMs = DEFAULT_FORCE_TIMEOUT_MS,
} = {}) {
  const nextBin = path.join(cwd, "node_modules", "next", "dist", "bin", "next");
  return startOwnedProcess({
    command: process.execPath,
    args: [nextBin, "dev", "--hostname", "127.0.0.1", "--port", "3000"],
    cwd,
    env,
    stdio: interactiveInput ? ["pipe", "inherit", "inherit"] : "inherit",
    port: 3000,
    gracefulTimeoutMs,
    forceTimeoutMs,
  });
}

export function attachInteractiveEtx(controller, onEtx) {
  return installTtyEtxHandler({
    stdin: process.stdin,
    childStdin: controller.child.stdin,
    onEtx,
  });
}

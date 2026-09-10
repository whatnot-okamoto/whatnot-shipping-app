import { pathToFileURL } from "node:url";
import { emitKeypressEvents } from "node:readline";
import { analyzePartialCancellationV2 } from "../lib/partial-cancel-diagnostic-v2.ts";

export const BASE_ORDER_DETAIL_URL = "https://api.thebase.in/1/orders/detail";
export const REQUEST_TIMEOUT_MS = 15_000;
export const HTTP_RESPONSE_MAX_BYTES = 1_048_576;
export const TOKEN_MAX_CHARACTERS = 4_096;
export const ORDER_ID_MAX_CHARACTERS = 128;

export const CLI_EXIT_CODES = Object.freeze({
  PASS_ENUM_COMPLETE: 0,
  STOP_ENUM_INDETERMINATE: 20,
  STOP_RUNTIME_BOUNDARY: 21,
  STOP_INPUT: 22,
  STOP_TIMEOUT: 23,
  STOP_TRANSPORT: 24,
  STOP_HTTP: 25,
  STOP_RESPONSE_TOO_LARGE: 26,
  STOP_RESPONSE_BODY: 27,
  STOP_RESPONSE_SCHEMA: 28,
  STOP_INTERNAL: 29,
});

class DiagnosticStop extends Error {
  constructor(code) {
    super(code);
    this.name = "DiagnosticStop";
    this.code = code;
  }
}

function assertSafeEnvironment(environment, argv) {
  if (argv.length !== 2) throw new DiagnosticStop("STOP_RUNTIME_BOUNDARY");
  if (
    environment.APP_ENVIRONMENT !== "development" ||
    environment.BASE_DATA_MODE !== "readonly"
  ) {
    throw new DiagnosticStop("STOP_RUNTIME_BOUNDARY");
  }
  const token = environment.BASE_READONLY_ACCESS_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    throw new DiagnosticStop("STOP_RUNTIME_BOUNDARY");
  }
  if (token.length > TOKEN_MAX_CHARACTERS) {
    throw new DiagnosticStop("STOP_RUNTIME_BOUNDARY");
  }
  for (const forbiddenName of [
    "BASE_API_TOKEN",
    "BASE_API_REFRESH_TOKEN",
    "BASE_CLIENT_ID",
    "BASE_CLIENT_SECRET",
    "BASE_REDIRECT_URI",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "VERCEL_ENV",
    "VERCEL_GIT_COMMIT_REF",
  ]) {
    if (Object.prototype.hasOwnProperty.call(environment, forbiddenName)) {
      throw new DiagnosticStop("STOP_RUNTIME_BOUNDARY");
    }
  }
}

export async function readHiddenOrderId(input = process.stdin) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new DiagnosticStop("STOP_INPUT");
  }

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    let exceeded = false;
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
    };
    const onKeypress = (text, key) => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        reject(new DiagnosticStop("STOP_INPUT"));
      } else if (key?.name === "return" || key?.name === "enter") {
        cleanup();
        const normalized = value.trim();
        if (
          exceeded ||
          !new RegExp(`^[A-Za-z0-9_-]{1,${ORDER_ID_MAX_CHARACTERS}}$`).test(
            normalized
          )
        ) {
          reject(new DiagnosticStop("STOP_INPUT"));
        } else {
          resolve(normalized);
        }
      } else if (key?.name === "backspace") {
        value = value.slice(0, -1);
      } else if (text && !key?.ctrl && !key?.meta) {
        if (value.length >= ORDER_ID_MAX_CHARACTERS) exceeded = true;
        else value += text;
      }
    };
    input.on("keypress", onKeypress);
  });
}

async function readBoundedHttpBody(response, maximumBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new DiagnosticStop("STOP_RESPONSE_BODY");
  }
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new DiagnosticStop("STOP_RESPONSE_BODY");
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      throw new DiagnosticStop("STOP_RESPONSE_BODY");
    }
    if (parsedLength > maximumBytes) {
      throw new DiagnosticStop("STOP_RESPONSE_TOO_LARGE");
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new DiagnosticStop("STOP_RESPONSE_BODY");
      }
      received += value.byteLength;
      if (!Number.isSafeInteger(received) || received > maximumBytes) {
        throw new DiagnosticStop("STOP_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new DiagnosticStop("STOP_RESPONSE_BODY");
  }
}

export async function runPartialCancelDiagnostic({
  environment = process.env,
  argv = process.argv,
  fetchImpl = globalThis.fetch,
  readOrderId = readHiddenOrderId,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  responseMaximumBytes = HTTP_RESPONSE_MAX_BYTES,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  try {
    assertSafeEnvironment(environment, argv);
    const uniqueKey = await readOrderId();
    if (
      typeof uniqueKey !== "string" ||
      !new RegExp(`^[A-Za-z0-9_-]{1,${ORDER_ID_MAX_CHARACTERS}}$`).test(uniqueKey)
    ) {
      throw new DiagnosticStop("STOP_INPUT");
    }

    const controller = new AbortController();
    const timer = setTimeoutImpl(() => controller.abort(), requestTimeoutMs);
    let bodyText;
    try {
      const response = await fetchImpl(
        `${BASE_ORDER_DETAIL_URL}/${encodeURIComponent(uniqueKey)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${environment.BASE_READONLY_ACCESS_TOKEN}`,
          },
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        }
      );
      if (!response?.ok) throw new DiagnosticStop("STOP_HTTP");
      bodyText = await readBoundedHttpBody(response, responseMaximumBytes);
    } catch (error) {
      if (error instanceof DiagnosticStop) throw error;
      throw new DiagnosticStop(
        controller.signal.aborted ? "STOP_TIMEOUT" : "STOP_TRANSPORT"
      );
    } finally {
      clearTimeoutImpl(timer);
    }

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new DiagnosticStop("STOP_RESPONSE_BODY");
    }

    let diagnostic;
    try {
      diagnostic = analyzePartialCancellationV2(body?.order ?? body);
    } catch {
      throw new DiagnosticStop("STOP_RESPONSE_SCHEMA");
    }
    return {
      stdoutRecord: diagnostic,
      stderrCode:
        diagnostic.outcome === "pass_enum_complete"
          ? null
          : "STOP_ENUM_INDETERMINATE",
      exitCode:
        diagnostic.outcome === "pass_enum_complete"
          ? CLI_EXIT_CODES.PASS_ENUM_COMPLETE
          : CLI_EXIT_CODES.STOP_ENUM_INDETERMINATE,
    };
  } catch (error) {
    const code =
      error instanceof DiagnosticStop && codeHasExit(error.code)
        ? error.code
        : "STOP_INTERNAL";
    return { stdoutRecord: null, stderrCode: code, exitCode: CLI_EXIT_CODES[code] };
  }
}

function codeHasExit(code) {
  return Object.prototype.hasOwnProperty.call(CLI_EXIT_CODES, code);
}

export function serializeCliOutcome(outcome) {
  return {
    stdout:
      outcome.stdoutRecord === null
        ? ""
        : `${JSON.stringify(outcome.stdoutRecord)}\n`,
    stderr: outcome.stderrCode === null ? "" : `${outcome.stderrCode}\n`,
    exitCode: outcome.exitCode,
  };
}

async function main() {
  const outcome = serializeCliOutcome(await runPartialCancelDiagnostic());
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exitCode = outcome.exitCode;
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(() => {
    process.stderr.write("STOP_INTERNAL\n");
    process.exitCode = CLI_EXIT_CODES.STOP_INTERNAL;
  });
}

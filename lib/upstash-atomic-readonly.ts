import {
  assertDevelopmentRedis,
  type DevelopmentRedisLike,
} from "./namespaced-redis";
import type { RedisLike } from "./redis-like";
import { UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY } from "./upstash-atomic-contract";

export type UpstashAtomicReadOnlyClassification =
  | "PASS_READONLY_BOUNDARY"
  | "STOP_READONLY_AUTH"
  | "STOP_READONLY_TIMEOUT"
  | "STOP_READONLY_TRANSPORT"
  | "STOP_READONLY_INDETERMINATE"
  | "STOP_READONLY_BEFORE_FETCH"
  | "STOP_READONLY_HTTP"
  | "STOP_READONLY_RESPONSE_PROCESSING";

type ReadOnlyFailureKind = "auth" | "timeout" | "transport" | "http";
type ReadOnlyProgress =
  | "RUNNER_STARTED"
  | "FETCH_STARTED"
  | "RESPONSE_RECEIVED"
  | "RESPONSE_OK"
  | "GET_COMPLETED";

class FixedReadOnlyFailure extends Error {
  readonly kind: ReadOnlyFailureKind;

  constructor(kind: ReadOnlyFailureKind) {
    super("Fixed read-only transport classification.");
    this.name = "FixedReadOnlyFailure";
    this.kind = kind;
  }
}

const TRANSPORT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function requireDevelopmentRedis(
  redis: RedisLike
): DevelopmentRedisLike | null {
  try {
    assertDevelopmentRedis(redis);
    return redis;
  } catch {
    return null;
  }
}

function isTimeoutSignal(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "TimeoutError"
  );
}

function getStructuredTransportCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return null;
  }
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return null;
  }
  return typeof cause.code === "string" ? cause.code : null;
}

function isStructuredTransportFailure(error: unknown): boolean {
  const code = getStructuredTransportCode(error);
  if (code === null) return false;
  return (
    TRANSPORT_ERROR_CODES.has(code) ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("CERT_") ||
    code.endsWith("_CERT_SIGNATURE_FAILURE") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  );
}

function isStructuredTimeoutFailure(error: unknown): boolean {
  const code = getStructuredTransportCode(error);
  return code !== null && TIMEOUT_ERROR_CODES.has(code);
}

function classificationForFailure(
  error: unknown
): UpstashAtomicReadOnlyClassification {
  if (!(error instanceof FixedReadOnlyFailure)) {
    return "STOP_READONLY_INDETERMINATE";
  }
  if (error.kind === "auth") return "STOP_READONLY_AUTH";
  if (error.kind === "timeout") return "STOP_READONLY_TIMEOUT";
  if (error.kind === "transport") return "STOP_READONLY_TRANSPORT";
  return "STOP_READONLY_HTTP";
}

export async function runUpstashAtomicReadOnlyBoundary(
  candidate: RedisLike
): Promise<UpstashAtomicReadOnlyClassification> {
  const observation: { progress: ReadOnlyProgress } = {
    progress: "RUNNER_STARTED",
  };
  const redis = requireDevelopmentRedis(candidate);
  if (!redis || typeof globalThis.fetch !== "function") {
    return "STOP_READONLY_BEFORE_FETCH";
  }

  const originalFetch = globalThis.fetch;
  const fixedFetch: typeof fetch = async (input, init) => {
    observation.progress = "FETCH_STARTED";
    try {
      const response = await originalFetch(input, init);
      if (!(response instanceof Response)) throw new Error();
      observation.progress = "RESPONSE_RECEIVED";
      if (response.status === 401 || response.status === 403) {
        throw new FixedReadOnlyFailure("auth");
      }
      if (!response.ok) {
        throw new FixedReadOnlyFailure("http");
      }
      observation.progress = "RESPONSE_OK";
      return response;
    } catch (error) {
      if (error instanceof FixedReadOnlyFailure) throw error;
      if (isTimeoutSignal(init?.signal)) {
        throw new FixedReadOnlyFailure("timeout");
      }
      if (isStructuredTimeoutFailure(error)) {
        throw new FixedReadOnlyFailure("timeout");
      }
      if (isStructuredTransportFailure(error)) {
        throw new FixedReadOnlyFailure("transport");
      }
      throw error;
    }
  };

  try {
    globalThis.fetch = fixedFetch;
  } catch {
    return "STOP_READONLY_BEFORE_FETCH";
  }

  let classification: UpstashAtomicReadOnlyClassification;
  try {
    try {
      await redis.get<unknown>(UPSTASH_ATOMIC_DIAGNOSTIC_GUARD_KEY);
      observation.progress = "GET_COMPLETED";
      classification = "PASS_READONLY_BOUNDARY";
    } catch (error) {
      if (error instanceof FixedReadOnlyFailure) {
        classification = classificationForFailure(error);
      } else if (observation.progress === "RUNNER_STARTED") {
        classification = "STOP_READONLY_BEFORE_FETCH";
      } else if (observation.progress === "RESPONSE_OK") {
        classification = "STOP_READONLY_RESPONSE_PROCESSING";
      } else {
        // This also covers the structural residual where fetch resolved
        // without a native Response. No raw detail leaves this process.
        classification = "STOP_READONLY_INDETERMINATE";
      }
    }
  } finally {
    try {
      globalThis.fetch = originalFetch;
    } catch {
      if (observation.progress === "RUNNER_STARTED") {
        classification = "STOP_READONLY_BEFORE_FETCH";
      } else if (observation.progress === "RESPONSE_OK") {
        classification = "STOP_READONLY_RESPONSE_PROCESSING";
      } else {
        classification = "STOP_READONLY_INDETERMINATE";
      }
    }
  }

  return classification;
}

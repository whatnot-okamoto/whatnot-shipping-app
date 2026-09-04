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
  | "STOP_READONLY_RESPONSE_PROCESSING"
  | "STOP_READONLY_LOCAL_REQUEST";

type ReadOnlyFailureKind =
  | "auth"
  | "timeout"
  | "transport"
  | "http"
  | "localRequest";
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
  "CERT_CHAIN_TOO_LONG",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_DH_PARAM_SIZE",
  "ERR_TLS_RENEGOTIATION_DISABLED",
  "ERR_TLS_SESSION_ATTACK",
  "ERR_TLS_SNI_FROM_SERVER",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_HEADERS_OVERFLOW",
  "UND_ERR_PRX_TLS",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_RES_EXCEEDED_MAX_SIZE",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);
const LOCAL_REQUEST_ERROR_CODES = new Set([
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_THIS",
  "ERR_INVALID_URL",
  "ERR_INVALID_URL_SCHEME",
  "UND_ERR_INVALID_ARG",
  "UND_ERR_INVALID_RETURN_VALUE",
  "UND_ERR_NOT_SUPPORTED",
  "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
]);
const MAX_ERROR_TRAVERSAL_DEPTH = 3;
const MAX_AGGREGATE_ERROR_COUNT = 8;
const MAX_INSPECTED_ERROR_OBJECTS = 32;

type OwnDataProperty =
  | { status: "missing" }
  | { status: "data"; value: unknown }
  | { status: "unsafe" };

type StructuredCodeExtraction = {
  codes: string[];
  conclusive: boolean;
};

type StructuredCodeFamily = "timeout" | "transport" | "localRequest";

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

function getOwnDataProperty(
  value: object,
  property: PropertyKey
): OwnDataProperty {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (descriptor === undefined) return { status: "missing" };
    if (!Object.hasOwn(descriptor, "value")) return { status: "unsafe" };
    return { status: "data", value: descriptor.value };
  } catch {
    return { status: "unsafe" };
  }
}

function extractStructuredCodes(error: unknown): StructuredCodeExtraction {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const visited = new Set<object>();
  const codes: string[] = [];
  let inspectedObjects = 0;

  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    if (typeof current.value !== "object" || current.value === null) {
      return { codes, conclusive: false };
    }
    if (visited.has(current.value)) {
      return { codes, conclusive: false };
    }
    if (inspectedObjects >= MAX_INSPECTED_ERROR_OBJECTS) {
      return { codes, conclusive: false };
    }
    visited.add(current.value);
    inspectedObjects += 1;

    const code = getOwnDataProperty(current.value, "code");
    if (code.status === "unsafe") return { codes, conclusive: false };
    if (code.status === "data") {
      if (typeof code.value !== "string") {
        return { codes, conclusive: false };
      }
      codes.push(code.value);
    }

    const cause = getOwnDataProperty(current.value, "cause");
    if (cause.status === "unsafe") return { codes, conclusive: false };
    if (cause.status === "data" && cause.value !== undefined) {
      if (
        typeof cause.value !== "object" ||
        cause.value === null ||
        current.depth >= MAX_ERROR_TRAVERSAL_DEPTH
      ) {
        return { codes, conclusive: false };
      }
      pending.push({ value: cause.value, depth: current.depth + 1 });
    }

    const errors = getOwnDataProperty(current.value, "errors");
    if (errors.status === "unsafe") return { codes, conclusive: false };
    if (errors.status === "data") {
      let isArray = false;
      try {
        isArray = Array.isArray(errors.value);
      } catch {
        return { codes, conclusive: false };
      }
      if (!isArray || current.depth >= MAX_ERROR_TRAVERSAL_DEPTH) {
        return { codes, conclusive: false };
      }
      const errorArray = errors.value as unknown[];
      const length = getOwnDataProperty(errorArray, "length");
      if (
        length.status !== "data" ||
        typeof length.value !== "number" ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        length.value > MAX_AGGREGATE_ERROR_COUNT
      ) {
        return { codes, conclusive: false };
      }
      for (let index = 0; index < length.value; index += 1) {
        const member = getOwnDataProperty(errorArray, String(index));
        if (member.status !== "data") return { codes, conclusive: false };
        pending.push({ value: member.value, depth: current.depth + 1 });
      }
    }
  }

  return { codes, conclusive: true };
}

function classifyStructuredCode(code: string): StructuredCodeFamily | null {
  if (TIMEOUT_ERROR_CODES.has(code)) return "timeout";
  if (LOCAL_REQUEST_ERROR_CODES.has(code)) return "localRequest";
  if (TRANSPORT_ERROR_CODES.has(code) || code.startsWith("HPE_")) {
    return "transport";
  }
  return null;
}

function classifyStructuredFailure(
  error: unknown
): StructuredCodeFamily | null {
  const extraction = extractStructuredCodes(error);
  if (!extraction.conclusive || extraction.codes.length === 0) return null;

  let family: StructuredCodeFamily | null = null;
  for (const code of extraction.codes) {
    const candidate = classifyStructuredCode(code);
    if (candidate === null) return null;
    if (family !== null && candidate !== family) return null;
    family = candidate;
  }
  return family;
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
  if (error.kind === "localRequest") return "STOP_READONLY_LOCAL_REQUEST";
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
      const structuredFailure = classifyStructuredFailure(error);
      if (structuredFailure === "timeout") {
        throw new FixedReadOnlyFailure("timeout");
      }
      if (structuredFailure === "transport") {
        throw new FixedReadOnlyFailure("transport");
      }
      if (structuredFailure === "localRequest") {
        throw new FixedReadOnlyFailure("localRequest");
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

import { randomBytes } from "node:crypto";
import {
  assertDevelopmentRedis,
  type DevelopmentRedisLike,
} from "./namespaced-redis";

const CANONICAL_PREFIX = "base-readonly-oauth:v1:";
const CONTROL_KEY = "auth:base_readonly_control";
const TOKEN_KEY = "auth:base_readonly_token";
const OWNER_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type EnabledControlRecord = {
  version: 1;
  status: "enabled";
  lease_id: string;
  expires_at: number;
};

type DisabledControlRecord = {
  version: 1;
  status: "disabled";
  disabled_at: number;
  reason: "cleanup";
};

type ControlRecord = EnabledControlRecord | DisabledControlRecord;
type OwnedRecordKind = "state" | "claim" | "refresh_lock" | "token";

type OwnedEnvelope<T> = {
  version: 1;
  kind: OwnedRecordKind;
  lease_id: string;
  operation_id: string;
  payload: T;
};

declare const enabledLeaseHandleBrand: unique symbol;
export type EnabledLeaseHandle = Readonly<{
  [enabledLeaseHandleBrand]: true;
}>;

declare const ownedRecordBrand: unique symbol;
export type OwnedOAuthRecord<T> = Readonly<{
  [ownedRecordBrand]: T;
}>;

type LeaseDetails = {
  canonical: string;
  leaseId: string;
  expiresAt: number;
};

type OwnedDetails<T> = {
  canonical: string;
  handle: EnabledLeaseHandle;
  kind: OwnedRecordKind;
  payload: T;
};

export class BaseReadonlyOAuthDisabledError extends Error {
  readonly code = "BASE_READONLY_OAUTH_DISABLED";

  constructor() {
    super("Development read-only OAuth is disabled.");
    this.name = "BaseReadonlyOAuthDisabledError";
  }
}

export class BaseReadonlyOAuthOwnershipError extends Error {
  readonly code = "BASE_READONLY_OAUTH_OWNERSHIP_INVALID";

  constructor() {
    super("Development read-only OAuth operation ownership is invalid.");
    this.name = "BaseReadonlyOAuthOwnershipError";
  }
}

export class BaseReadonlyOAuthCleanupError extends Error {
  readonly code = "BASE_READONLY_OAUTH_CLEANUP_FAILED";

  constructor() {
    super("Development read-only OAuth cleanup failed safely.");
    this.name = "BaseReadonlyOAuthCleanupError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeCanonical(value: unknown): string {
  return `${CANONICAL_PREFIX}${JSON.stringify(value)}`;
}

function parseCanonical(value: unknown): unknown | null {
  if (typeof value !== "string" || !value.startsWith(CANONICAL_PREFIX)) {
    return null;
  }
  try {
    return JSON.parse(value.slice(CANONICAL_PREFIX.length));
  } catch {
    return null;
  }
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOwnerId(value: unknown): value is string {
  return typeof value === "string" && OWNER_ID_PATTERN.test(value);
}

function parseControlRecord(value: unknown): {
  record: ControlRecord;
  canonical: string;
} | null {
  const parsed = parseCanonical(value);
  if (!isRecord(parsed) || parsed.version !== 1) return null;

  let record: ControlRecord;
  if (
    parsed.status === "enabled" &&
    isOwnerId(parsed.lease_id) &&
    isSafeTimestamp(parsed.expires_at)
  ) {
    record = {
      version: 1,
      status: "enabled",
      lease_id: parsed.lease_id,
      expires_at: parsed.expires_at,
    };
  } else if (
    parsed.status === "disabled" &&
    isSafeTimestamp(parsed.disabled_at) &&
    parsed.reason === "cleanup"
  ) {
    record = {
      version: 1,
      status: "disabled",
      disabled_at: parsed.disabled_at,
      reason: "cleanup",
    };
  } else {
    return null;
  }

  const canonical = serializeCanonical(record);
  return value === canonical ? { record, canonical } : null;
}

function createRandomOwnerId(randomOwnerBytes: () => Uint8Array): string {
  const bytes = randomOwnerBytes();
  if (bytes.byteLength < 32) {
    throw new BaseReadonlyOAuthOwnershipError();
  }
  return Buffer.from(bytes).toString("base64url");
}

export type BaseReadonlyOAuthControl = ReturnType<
  typeof createBaseReadonlyOAuthControl
>;

export function createBaseReadonlyOAuthControl(
  redis: DevelopmentRedisLike,
  options: {
    now?: () => number;
    randomOwnerBytes?: () => Uint8Array;
  } = {}
) {
  assertDevelopmentRedis(redis);
  const now = options.now ?? Date.now;
  const randomOwnerBytes = options.randomOwnerBytes ?? (() => randomBytes(32));
  const leaseDetails = new WeakMap<object, LeaseDetails>();
  const ownedDetails = new WeakMap<object, OwnedDetails<unknown>>();

  function getLeaseDetails(handle: EnabledLeaseHandle): LeaseDetails {
    const details = leaseDetails.get(handle);
    if (!details) throw new BaseReadonlyOAuthDisabledError();
    return details;
  }

  function getOwnedDetails<T>(record: OwnedOAuthRecord<T>): OwnedDetails<T> {
    const details = ownedDetails.get(record) as OwnedDetails<T> | undefined;
    if (!details) throw new BaseReadonlyOAuthOwnershipError();
    return details;
  }

  async function readControl(): Promise<unknown> {
    try {
      return await redis.get<unknown>(CONTROL_KEY);
    } catch {
      throw new BaseReadonlyOAuthDisabledError();
    }
  }

  async function captureEnabledLease(): Promise<EnabledLeaseHandle> {
    const parsed = parseControlRecord(await readControl());
    const nowValue = now();
    if (
      !parsed ||
      parsed.record.status !== "enabled" ||
      !isSafeTimestamp(nowValue) ||
      parsed.record.expires_at <= nowValue
    ) {
      throw new BaseReadonlyOAuthDisabledError();
    }

    const handle = Object.freeze({}) as EnabledLeaseHandle;
    leaseDetails.set(handle, {
      canonical: parsed.canonical,
      leaseId: parsed.record.lease_id,
      expiresAt: parsed.record.expires_at,
    });
    return handle;
  }

  async function assertSameEnabledLease(
    handle: EnabledLeaseHandle
  ): Promise<void> {
    const expected = getLeaseDetails(handle);
    const current = await readControl();
    const nowValue = now();
    if (
      current !== expected.canonical ||
      !isSafeTimestamp(nowValue) ||
      expected.expiresAt <= nowValue
    ) {
      throw new BaseReadonlyOAuthDisabledError();
    }
  }

  function createOwnedRecord<T>(
    handle: EnabledLeaseHandle,
    kind: OwnedRecordKind,
    payload: T
  ): OwnedOAuthRecord<T> {
    const lease = getLeaseDetails(handle);
    const envelope: OwnedEnvelope<T> = {
      version: 1,
      kind,
      lease_id: lease.leaseId,
      operation_id: createRandomOwnerId(randomOwnerBytes),
      payload,
    };
    const record = Object.freeze({}) as OwnedOAuthRecord<T>;
    ownedDetails.set(record, {
      canonical: serializeCanonical(envelope),
      handle,
      kind,
      payload,
    });
    return record;
  }

  function parseOwnedRecord<T>(
    handle: EnabledLeaseHandle,
    value: unknown,
    kind: OwnedRecordKind,
    normalizePayload: (payload: unknown) => T | null
  ): OwnedOAuthRecord<T> | null {
    const lease = getLeaseDetails(handle);
    const parsed = parseCanonical(value);
    const payload = isRecord(parsed)
      ? normalizePayload(parsed.payload)
      : null;
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      parsed.kind !== kind ||
      parsed.lease_id !== lease.leaseId ||
      !isOwnerId(parsed.operation_id) ||
      payload === null
    ) {
      return null;
    }
    const envelope: OwnedEnvelope<T> = {
      version: 1,
      kind,
      lease_id: parsed.lease_id,
      operation_id: parsed.operation_id,
      payload,
    };
    const canonical = serializeCanonical(envelope);
    if (value !== canonical) return null;

    const record = Object.freeze({}) as OwnedOAuthRecord<T>;
    ownedDetails.set(record, { canonical, handle, kind, payload });
    return record;
  }

  function getOwnedPayload<T>(record: OwnedOAuthRecord<T>): T {
    return getOwnedDetails(record).payload;
  }

  async function rollbackOwnedRecord<T>(
    key: string,
    record: OwnedOAuthRecord<T>
  ): Promise<void> {
    const details = getOwnedDetails(record);
    let deleted: boolean;
    try {
      deleted = await redis.compareAndDelete(key, details.canonical);
    } catch {
      throw new BaseReadonlyOAuthOwnershipError();
    }
    if (!deleted) throw new BaseReadonlyOAuthOwnershipError();
  }

  async function setOwnedIfAbsent<T>(
    handle: EnabledLeaseHandle,
    key: string,
    record: OwnedOAuthRecord<T>,
    ttlSeconds: number
  ): Promise<boolean> {
    const details = getOwnedDetails(record);
    if (details.handle !== handle) throw new BaseReadonlyOAuthOwnershipError();
    await assertSameEnabledLease(handle);
    let saved: "OK" | null;
    try {
      saved = await redis.set(key, details.canonical, {
        nx: true,
        ex: ttlSeconds,
      });
    } catch {
      throw new BaseReadonlyOAuthOwnershipError();
    }
    if (saved !== "OK") return false;
    try {
      await assertSameEnabledLease(handle);
      return true;
    } catch {
      await rollbackOwnedRecord(key, record);
      throw new BaseReadonlyOAuthDisabledError();
    }
  }

  async function readOwnedRecord<T>(
    handle: EnabledLeaseHandle,
    key: string,
    kind: OwnedRecordKind,
    normalizePayload: (payload: unknown) => T | null
  ): Promise<OwnedOAuthRecord<T> | null> {
    await assertSameEnabledLease(handle);
    let raw: unknown;
    try {
      raw = await redis.get<unknown>(key);
    } catch {
      throw new BaseReadonlyOAuthOwnershipError();
    }
    const parsed = parseOwnedRecord(handle, raw, kind, normalizePayload);
    await assertSameEnabledLease(handle);
    return parsed;
  }

  async function consumeOwnedRecord<T>(
    handle: EnabledLeaseHandle,
    key: string,
    record: OwnedOAuthRecord<T>
  ): Promise<void> {
    const details = getOwnedDetails(record);
    if (details.handle !== handle) throw new BaseReadonlyOAuthOwnershipError();
    await assertSameEnabledLease(handle);
    let deleted: boolean;
    try {
      deleted = await redis.compareAndDelete(key, details.canonical);
    } catch {
      throw new BaseReadonlyOAuthOwnershipError();
    }
    if (!deleted) throw new BaseReadonlyOAuthOwnershipError();
    await assertSameEnabledLease(handle);
  }

  async function saveTokenForLease<T>(
    handle: EnabledLeaseHandle,
    record: OwnedOAuthRecord<T>
  ): Promise<void> {
    const lease = getLeaseDetails(handle);
    const details = getOwnedDetails(record);
    if (details.handle !== handle || details.kind !== "token") {
      throw new BaseReadonlyOAuthOwnershipError();
    }
    await assertSameEnabledLease(handle);
    let saved: boolean;
    try {
      saved = await redis.setIfValueMatches(
        CONTROL_KEY,
        lease.canonical,
        TOKEN_KEY,
        details.canonical
      );
    } catch {
      throw new BaseReadonlyOAuthOwnershipError();
    }
    if (!saved) throw new BaseReadonlyOAuthDisabledError();
    try {
      await assertSameEnabledLease(handle);
    } catch {
      await rollbackOwnedRecord(TOKEN_KEY, record);
      throw new BaseReadonlyOAuthDisabledError();
    }
  }

  async function readTokenForLease<T>(
    handle: EnabledLeaseHandle,
    normalizePayload: (payload: unknown) => T | null
  ): Promise<OwnedOAuthRecord<T> | null> {
    return readOwnedRecord(handle, TOKEN_KEY, "token", normalizePayload);
  }

  async function disableForCleanup(): Promise<"created" | "replaced" | "already_disabled"> {
    let raw: unknown;
    try {
      raw = await redis.get<unknown>(CONTROL_KEY);
    } catch {
      throw new BaseReadonlyOAuthCleanupError();
    }
    const parsed = raw === null ? null : parseControlRecord(raw);
    if (raw !== null && !parsed) throw new BaseReadonlyOAuthCleanupError();
    if (parsed?.record.status === "disabled") return "already_disabled";

    const disabledAt = now();
    if (!isSafeTimestamp(disabledAt)) throw new BaseReadonlyOAuthCleanupError();
    const disabled: DisabledControlRecord = {
      version: 1,
      status: "disabled",
      disabled_at: disabledAt,
      reason: "cleanup",
    };
    let saved: "OK" | null;
    try {
      saved = await redis.set(CONTROL_KEY, serializeCanonical(disabled));
    } catch {
      throw new BaseReadonlyOAuthCleanupError();
    }
    if (saved !== "OK") throw new BaseReadonlyOAuthCleanupError();
    return raw === null ? "created" : "replaced";
  }

  async function assertDisabledControl(): Promise<void> {
    let raw: unknown;
    try {
      raw = await redis.get<unknown>(CONTROL_KEY);
    } catch {
      throw new BaseReadonlyOAuthCleanupError();
    }
    const parsed = parseControlRecord(raw);
    if (!parsed || parsed.record.status !== "disabled") {
      throw new BaseReadonlyOAuthCleanupError();
    }
  }

  return {
    captureEnabledLease,
    assertSameEnabledLease,
    createOwnedRecord,
    readOwnedRecord,
    getOwnedPayload,
    setOwnedIfAbsent,
    consumeOwnedRecord,
    rollbackOwnedRecord,
    saveTokenForLease,
    readTokenForLease,
    disableForCleanup,
    assertDisabledControl,
  };
}

export const BASE_READONLY_CONTROL_LOGICAL_KEY = CONTROL_KEY;
export const BASE_READONLY_TOKEN_LOGICAL_KEY = TOKEN_KEY;
export const BASE_READONLY_CANONICAL_PREFIX = CANONICAL_PREFIX;

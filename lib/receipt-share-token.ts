import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const TOKEN_VERSION = "v1";
const TOKEN_AAD = Buffer.from("whatnot-receipt-share:v1", "utf8");
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const MIN_SECRET_BYTES = 32;
const MAX_TOKEN_LENGTH = 4096;

export const RECEIPT_SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Client ComponentからNode専用crypto moduleをimportしないため、client側定数とは
// ファイルを分け、テストで一致を固定する。
export const MAX_RECEIPT_NAME_LENGTH = 18;
export const MAX_RECEIPT_NOTE_LENGTH = 22;

export type ReceiptSharePayload = {
  version: 1;
  uniqueKey: string;
  receiptName: string;
  receiptNote: string;
  issuedAt: number;
  expiresAt: number;
};

export type CreateReceiptShareTokenInput = {
  uniqueKey: string;
  receiptName: string;
  receiptNote: string;
};

export type ReceiptShareTokenErrorCode =
  | "invalid"
  | "expired"
  | "configuration";

export class ReceiptShareTokenError extends Error {
  readonly code: ReceiptShareTokenErrorCode;

  constructor(code: ReceiptShareTokenErrorCode, message: string) {
    super(message);
    this.name = "ReceiptShareTokenError";
    this.code = code;
  }
}

type TokenOptions = {
  secret?: string;
  now?: number;
};

function getSecret(explicitSecret?: string): string {
  const secret = explicitSecret ?? process.env.RECEIPT_SHARE_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new ReceiptShareTokenError(
      "configuration",
      `RECEIPT_SHARE_SECRET must be at least ${MIN_SECRET_BYTES} UTF-8 bytes`
    );
  }
  return secret;
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function hasUnsupportedControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function assertTextField(
  value: unknown,
  fieldName: string,
  maxLength: number
): asserts value is string {
  if (typeof value !== "string") {
    throw new ReceiptShareTokenError("invalid", `${fieldName} must be a string`);
  }
  if (countCharacters(value) > maxLength) {
    throw new ReceiptShareTokenError(
      "invalid",
      `${fieldName} must be ${maxLength} characters or fewer`
    );
  }
  if (hasUnsupportedControlCharacter(value)) {
    throw new ReceiptShareTokenError(
      "invalid",
      `${fieldName} contains an unsupported control character`
    );
  }
}

function assertUniqueKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    hasUnsupportedControlCharacter(value)
  ) {
    throw new ReceiptShareTokenError("invalid", "uniqueKey is invalid");
  }
}

function assertPayload(value: unknown): asserts value is ReceiptSharePayload {
  if (!value || typeof value !== "object") {
    throw new ReceiptShareTokenError("invalid", "payload is invalid");
  }

  const payload = value as Partial<ReceiptSharePayload>;
  if (payload.version !== 1) {
    throw new ReceiptShareTokenError("invalid", "payload version is invalid");
  }
  assertUniqueKey(payload.uniqueKey);
  assertTextField(
    payload.receiptName,
    "receiptName",
    MAX_RECEIPT_NAME_LENGTH
  );
  assertTextField(
    payload.receiptNote,
    "receiptNote",
    MAX_RECEIPT_NOTE_LENGTH
  );
  if (
    typeof payload.issuedAt !== "number" ||
    !Number.isSafeInteger(payload.issuedAt) ||
    typeof payload.expiresAt !== "number" ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt !== RECEIPT_SHARE_TTL_MS
  ) {
    throw new ReceiptShareTokenError("invalid", "payload timestamps are invalid");
  }
}

export function validateReceiptShareInput(
  input: CreateReceiptShareTokenInput
): void {
  assertUniqueKey(input.uniqueKey);
  assertTextField(
    input.receiptName,
    "receiptName",
    MAX_RECEIPT_NAME_LENGTH
  );
  assertTextField(
    input.receiptNote,
    "receiptNote",
    MAX_RECEIPT_NOTE_LENGTH
  );
}

export function createReceiptShareToken(
  input: CreateReceiptShareTokenInput,
  options: TokenOptions = {}
): { token: string; payload: ReceiptSharePayload } {
  validateReceiptShareInput(input);
  const secret = getSecret(options.secret);
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new ReceiptShareTokenError("invalid", "current time is invalid");
  }

  const payload: ReceiptSharePayload = {
    version: 1,
    uniqueKey: input.uniqueKey,
    receiptName: input.receiptName,
    receiptNote: input.receiptNote,
    issuedAt: now,
    expiresAt: now + RECEIPT_SHARE_TTL_MS,
  };

  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  cipher.setAAD(TOKEN_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    token: [
      TOKEN_VERSION,
      iv.toString("base64url"),
      ciphertext.toString("base64url"),
      authTag.toString("base64url"),
    ].join("."),
    payload,
  };
}

export function readReceiptShareToken(
  token: string,
  options: TokenOptions = {}
): ReceiptSharePayload {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    throw new ReceiptShareTokenError("invalid", "token is invalid");
  }

  const [version, ivPart, ciphertextPart, authTagPart, extraPart] =
    token.split(".");
  if (
    version !== TOKEN_VERSION ||
    !ivPart ||
    !ciphertextPart ||
    !authTagPart ||
    extraPart !== undefined
  ) {
    throw new ReceiptShareTokenError("invalid", "token format is invalid");
  }

  try {
    const secret = getSecret(options.secret);
    const iv = Buffer.from(ivPart, "base64url");
    const ciphertext = Buffer.from(ciphertextPart, "base64url");
    const authTag = Buffer.from(authTagPart, "base64url");
    if (
      iv.length !== IV_LENGTH_BYTES ||
      ciphertext.length === 0 ||
      authTag.length !== AUTH_TAG_LENGTH_BYTES
    ) {
      throw new ReceiptShareTokenError("invalid", "token parts are invalid");
    }

    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAAD(TOKEN_AAD);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const payload: unknown = JSON.parse(plaintext);
    assertPayload(payload);

    const now = options.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new ReceiptShareTokenError("invalid", "current time is invalid");
    }
    if (now >= payload.expiresAt) {
      throw new ReceiptShareTokenError("expired", "token has expired");
    }

    return payload;
  } catch (error) {
    if (error instanceof ReceiptShareTokenError) {
      throw error;
    }
    throw new ReceiptShareTokenError("invalid", "token could not be read");
  }
}

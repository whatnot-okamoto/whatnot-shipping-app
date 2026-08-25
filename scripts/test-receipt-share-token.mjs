import assert from "node:assert/strict";
import {
  createReceiptShareToken,
  readReceiptShareToken,
  ReceiptShareTokenError,
  RECEIPT_SHARE_TTL_MS,
  MAX_RECEIPT_NAME_LENGTH as TOKEN_MAX_RECEIPT_NAME_LENGTH,
  MAX_RECEIPT_NOTE_LENGTH as TOKEN_MAX_RECEIPT_NOTE_LENGTH,
} from "../lib/receipt-share-token.ts";
import {
  MAX_RECEIPT_NAME_LENGTH,
  MAX_RECEIPT_NOTE_LENGTH,
} from "../lib/receipt-share-constants.ts";

assert.equal(MAX_RECEIPT_NAME_LENGTH, TOKEN_MAX_RECEIPT_NAME_LENGTH);
assert.equal(MAX_RECEIPT_NOTE_LENGTH, TOKEN_MAX_RECEIPT_NOTE_LENGTH);

const secret = "receipt-share-test-secret-0123456789-安全確認";
const now = Date.UTC(2026, 7, 25, 3, 4, 5);
const input = {
  uniqueKey: "TEST-ORDER-0001",
  receiptName: "髙橋 﨑 𠮷野 ㈱①",
  receiptNote: "お品代として（工具・部品）ＡＢＣ 123",
};

const first = createReceiptShareToken(input, { secret, now });
const decoded = readReceiptShareToken(first.token, { secret, now });

assert.equal(decoded.uniqueKey, input.uniqueKey);
assert.equal(decoded.receiptName, input.receiptName);
assert.equal(decoded.receiptNote, input.receiptNote);
assert.equal(decoded.issuedAt, now);
assert.equal(decoded.expiresAt, now + RECEIPT_SHARE_TTL_MS);
assert.equal(first.token.includes(input.uniqueKey), false);
assert.equal(first.token.includes(input.receiptName), false);

const second = createReceiptShareToken(input, { secret, now });
assert.notEqual(first.token, second.token, "IV must randomize each token");

const tokenParts = first.token.split(".");
const ciphertext = tokenParts[2];
const replacement = ciphertext[0] === "A" ? "B" : "A";
tokenParts[2] = replacement + ciphertext.slice(1);
assert.throws(
  () => readReceiptShareToken(tokenParts.join("."), { secret, now }),
  (error) =>
    error instanceof ReceiptShareTokenError && error.code === "invalid"
);

assert.throws(
  () =>
    readReceiptShareToken(first.token, {
      secret: "different-receipt-share-secret-0123456789",
      now,
    }),
  (error) =>
    error instanceof ReceiptShareTokenError && error.code === "invalid"
);

assert.throws(
  () =>
    readReceiptShareToken(first.token, {
      secret,
      now: now + RECEIPT_SHARE_TTL_MS,
    }),
  (error) =>
    error instanceof ReceiptShareTokenError && error.code === "expired"
);

const emptyFields = createReceiptShareToken(
  { uniqueKey: "TEST-ORDER-0002", receiptName: "", receiptNote: "" },
  { secret, now }
);
assert.equal(
  readReceiptShareToken(emptyFields.token, { secret, now }).receiptName,
  ""
);

assert.throws(
  () =>
    createReceiptShareToken(
      {
        uniqueKey: "TEST-ORDER-0003",
        receiptName: "改行\n不可",
        receiptNote: "",
      },
      { secret, now }
    ),
  (error) =>
    error instanceof ReceiptShareTokenError && error.code === "invalid"
);

assert.throws(
  () => createReceiptShareToken(input, { secret: "short", now }),
  (error) =>
    error instanceof ReceiptShareTokenError && error.code === "configuration"
);

const boundaryFields = createReceiptShareToken(
  {
    uniqueKey: "TEST-ORDER-0004",
    receiptName: "名".repeat(MAX_RECEIPT_NAME_LENGTH),
    receiptNote: "但".repeat(MAX_RECEIPT_NOTE_LENGTH),
  },
  { secret, now }
);
assert.equal(
  readReceiptShareToken(boundaryFields.token, { secret, now }).receiptName,
  "名".repeat(MAX_RECEIPT_NAME_LENGTH)
);
assert.throws(
  () =>
    createReceiptShareToken(
      {
        uniqueKey: "TEST-ORDER-0005",
        receiptName: "名".repeat(MAX_RECEIPT_NAME_LENGTH + 1),
        receiptNote: "",
      },
      { secret, now }
    ),
  (error) =>
    error instanceof ReceiptShareTokenError && error.code === "invalid"
);

console.log("receipt share token tests passed");

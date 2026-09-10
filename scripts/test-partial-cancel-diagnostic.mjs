import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  AMOUNT_PATH_KEYS,
  FORMULA_RELATION_KEYS,
  SHIPPING_CANDIDATE_KEYS,
  analyzePartialCancellationV2,
} from "../lib/partial-cancel-diagnostic-v2.ts";
import {
  BASE_ORDER_DETAIL_URL,
  CLI_EXIT_CODES,
  HTTP_RESPONSE_MAX_BYTES,
  readHiddenOrderId,
  runPartialCancelDiagnostic,
  serializeCliOutcome,
} from "./diagnose-partial-cancel.mjs";
import {
  normalFixture,
  paidOptionFixture,
  partialCancelFixture,
} from "./fixtures/partial-cancel-diagnostic-fixtures.mjs";

const forbiddenRealFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("real fetch is forbidden in this test");
};

const clone = (value) => structuredClone(value);
const formulaKey = (amount, shipping) => `${amount}__${shipping}`;
const assertUnresolvableShipping = (fixture) => {
  const result = analyzePartialCancellationV2(fixture);
  assert.equal(result.shippingLineItemScope, "unresolvable_or_invalid");
  assert.equal(result.outcome, "stop_indeterminate");
};

try {
  const partial = analyzePartialCancellationV2(clone(partialCancelFixture));
  assert.equal(partial.outcome, "pass_enum_complete");
  assert.equal(partial.cancellationCandidate, "partial_cancel");
  assert.equal(partial.cancellationConsistency, "consistent");
  assert.equal(partial.cancelledItemsRemainInOrderItems, "yes");
  assert.deepEqual(partial.taxRateComposition, {
    active: "rate_10_only",
    cancelled: "rate_8_only",
  });
  assert.equal(partial.shippingLineItemScope, "active_and_cancelled_items");
  assert.deepEqual(partial.adjustmentPresence, {
    discount: "present",
    coinDiscount: "present",
    adjustment: "present",
    codFee: "present",
  });
  assert.equal(
    partial.formulaRelations[
      formulaKey("item_total_field", "without_shipping")
    ],
    "does_not_match"
  );
  assert.equal(
    partial.formulaRelations[
      formulaKey("item_total_field", "order_shipping_fee")
    ],
    "matches"
  );
  assert.equal(
    partial.formulaRelations[
      formulaKey("item_total_field", "all_shipping_lines")
    ],
    "does_not_match"
  );
  assert.equal(
    partial.formulaRelations[
      formulaKey("item_total_field", "active_shipping_lines_only")
    ],
    "matches"
  );
  assert.deepEqual(Object.keys(partial.formulaRelations), FORMULA_RELATION_KEYS);
  assert.equal(
    FORMULA_RELATION_KEYS.length,
    AMOUNT_PATH_KEYS.length * SHIPPING_CANDIDATE_KEYS.length
  );
  assert.equal(JSON.stringify(partial).includes("MUST_NOT_APPEAR_IN_OUTPUT"), false);
  assert.equal(/[0-9]{3,}/.test(JSON.stringify(partial)), false);

  const normal = analyzePartialCancellationV2(clone(normalFixture));
  assert.equal(normal.outcome, "pass_enum_complete");
  assert.equal(normal.cancellationCandidate, "normal");
  assert.equal(normal.knownItemStatuses.dispatched, "present");
  assert.equal(normal.taxRateComposition.cancelled, "none");
  assert.equal(normal.shippingLineItemScope, "active_items_only");

  const paidOptions = analyzePartialCancellationV2(clone(paidOptionFixture));
  assert.equal(paidOptions.outcome, "pass_enum_complete");
  assert.equal(
    paidOptions.amountPathAgreement.active,
    "all_available_paths_agree"
  );

  const fixedAdjustmentOnly = clone(partialCancelFixture);
  fixedAdjustmentOnly.total = 980;
  delete fixedAdjustmentOnly.shipping_fee;
  delete fixedAdjustmentOnly.shipping_lines;
  for (const item of fixedAdjustmentOnly.order_items) delete item.shipping_fee;
  const noSubsetSearch = analyzePartialCancellationV2(fixedAdjustmentOnly);
  assert.equal(noSubsetSearch.outcome, "stop_indeterminate");
  assert.equal(
    Object.values(noSubsetSearch.formulaRelations).includes("matches"),
    false
  );

  const pathConflictFixture = clone(normalFixture);
  pathConflictFixture.order_items[0].total = 999;
  const pathConflict = analyzePartialCancellationV2(pathConflictFixture);
  assert.equal(pathConflict.outcome, "stop_indeterminate");
  assert.equal(
    pathConflict.amountPathAgreement.active,
    "available_paths_conflict"
  );

  const partialPathFixture = clone(normalFixture);
  delete partialPathFixture.order_items[0].option_total;
  const partialPath = analyzePartialCancellationV2(partialPathFixture);
  assert.equal(partialPath.outcome, "stop_indeterminate");
  assert.equal(
    partialPath.amountPathPresence.active.item_plus_option_total,
    "partially_present"
  );

  const unknownStatusFixture = clone(normalFixture);
  unknownStatusFixture.order_items[0].status = "unknown-status";
  const unknownStatus = analyzePartialCancellationV2(unknownStatusFixture);
  assert.equal(unknownStatus.outcome, "stop_indeterminate");
  assert.equal(unknownStatus.unknownItemStatus, "present");
  assert.equal(unknownStatus.cancellationCandidate, "indeterminate");

  const topLevelConflictFixture = clone(partialCancelFixture);
  topLevelConflictFixture.cancelled = 1;
  const topLevelConflict = analyzePartialCancellationV2(topLevelConflictFixture);
  assert.equal(topLevelConflict.outcome, "stop_indeterminate");
  assert.equal(topLevelConflict.cancellationConsistency, "conflict");

  const unknownTaxFixture = clone(partialCancelFixture);
  unknownTaxFixture.order_items[1].consumption_tax_rate = 5;
  const unknownTax = analyzePartialCancellationV2(unknownTaxFixture);
  assert.equal(unknownTax.outcome, "stop_indeterminate");
  assert.equal(
    unknownTax.taxRateComposition.cancelled,
    "unknown_rate_present"
  );

  const missingTaxFixture = clone(partialCancelFixture);
  delete missingTaxFixture.order_items[0].consumption_tax_rate;
  assert.equal(
    analyzePartialCancellationV2(missingTaxFixture).taxRateComposition.active,
    "indeterminate"
  );

  const mixedTaxFixture = clone(partialCancelFixture);
  mixedTaxFixture.order_items.push({
    ...clone(mixedTaxFixture.order_items[0]),
    order_item_id: 10003,
    consumption_tax_rate: 8,
  });
  mixedTaxFixture.order_items.push({
    ...clone(mixedTaxFixture.order_items[1]),
    order_item_id: 10004,
    consumption_tax_rate: 10,
  });
  const mixedTax = analyzePartialCancellationV2(mixedTaxFixture);
  assert.equal(mixedTax.taxRateComposition.active, "mixed_8_10");
  assert.equal(mixedTax.taxRateComposition.cancelled, "mixed_8_10");

  const nullAdjustmentFixture = clone(normalFixture);
  nullAdjustmentFixture.order_discount = null;
  const nullAdjustment = analyzePartialCancellationV2(nullAdjustmentFixture);
  assert.equal(nullAdjustment.outcome, "stop_indeterminate");
  assert.equal(nullAdjustment.adjustmentPresence.discount, "invalid");

  const missingAdjustmentFixture = clone(normalFixture);
  delete missingAdjustmentFixture.order_header_coin;
  const missingAdjustment = analyzePartialCancellationV2(missingAdjustmentFixture);
  assert.equal(missingAdjustment.outcome, "stop_indeterminate");
  assert.equal(missingAdjustment.adjustmentPresence.coinDiscount, "absent");
  assert.equal(
    Object.values(missingAdjustment.formulaRelations).every(
      (relation) => relation === "unavailable"
    ),
    true
  );

  const unsafeIntegerFixture = clone(normalFixture);
  unsafeIntegerFixture.order_items[0].total = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(
    analyzePartialCancellationV2(unsafeIntegerFixture).amountPathPresence.active
      .item_total_field,
    "invalid"
  );

  const overflowFixture = clone(normalFixture);
  overflowFixture.order_items[0].price = Number.MAX_SAFE_INTEGER;
  overflowFixture.order_items[0].amount = 2;
  assert.equal(
    analyzePartialCancellationV2(overflowFixture).amountPathPresence.active
      .price_plus_options_reconstructed,
    "invalid"
  );

  const itemIdWrongTypeFixture = clone(normalFixture);
  itemIdWrongTypeFixture.order_items[0].order_item_id = "20001";
  assertUnresolvableShipping(itemIdWrongTypeFixture);

  const shippingIdWrongTypeFixture = clone(normalFixture);
  shippingIdWrongTypeFixture.shipping_lines[0].order_item_ids = [20001];
  assertUnresolvableShipping(shippingIdWrongTypeFixture);

  const nonDecimalShippingIdFixture = clone(normalFixture);
  nonDecimalShippingIdFixture.shipping_lines[0].order_item_ids = ["active-1"];
  assertUnresolvableShipping(nonDecimalShippingIdFixture);

  const unsafeItemIdFixture = clone(normalFixture);
  unsafeItemIdFixture.order_items[0].order_item_id =
    Number.MAX_SAFE_INTEGER + 1;
  assertUnresolvableShipping(unsafeItemIdFixture);

  const unsafeShippingIdFixture = clone(normalFixture);
  unsafeShippingIdFixture.shipping_lines[0].order_item_ids = [
    "9007199254740992",
  ];
  assertUnresolvableShipping(unsafeShippingIdFixture);

  const unknownShippingIdFixture = clone(normalFixture);
  unknownShippingIdFixture.shipping_lines[0].order_item_ids = ["99999"];
  assertUnresolvableShipping(unknownShippingIdFixture);

  const nullShippingLinesFixture = clone(normalFixture);
  nullShippingLinesFixture.shipping_lines = null;
  assert.equal(
    analyzePartialCancellationV2(nullShippingLinesFixture).shippingLineItemScope,
    "unresolvable_or_invalid"
  );

  const nonNumericShippingFixture = clone(normalFixture);
  nonNumericShippingFixture.shipping_lines[0].shipping_fee = "100";
  assert.equal(
    analyzePartialCancellationV2(nonNumericShippingFixture).shippingLineItemScope,
    "unresolvable_or_invalid"
  );

  const duplicateItemIdFixture = clone(partialCancelFixture);
  duplicateItemIdFixture.order_items[1].order_item_id = 10001;
  assertUnresolvableShipping(duplicateItemIdFixture);

  const duplicateShippingIdFixture = clone(partialCancelFixture);
  duplicateShippingIdFixture.shipping_lines[1].order_item_ids = ["10001"];
  assertUnresolvableShipping(duplicateShippingIdFixture);

  const mixedLineFixture = clone(partialCancelFixture);
  mixedLineFixture.shipping_lines = [
    { shipping_fee: 100, order_item_ids: ["10001", "10002"] },
  ];
  const mixedLine = analyzePartialCancellationV2(mixedLineFixture);
  assert.equal(mixedLine.shippingLineItemScope, "active_and_cancelled_items");
  assert.equal(
    mixedLine.formulaRelations[
      formulaKey("item_total_field", "active_shipping_lines_only")
    ],
    "invalid"
  );

  const cancelledOnlyShippingFixture = clone(partialCancelFixture);
  cancelledOnlyShippingFixture.shipping_lines = [
    { shipping_fee: 50, order_item_ids: ["10002"] },
  ];
  assert.equal(
    analyzePartialCancellationV2(cancelledOnlyShippingFixture)
      .shippingLineItemScope,
    "cancelled_items_only"
  );

  const fullCancelFixture = clone(partialCancelFixture);
  fullCancelFixture.cancelled = 1;
  fullCancelFixture.total = 0;
  fullCancelFixture.order_items = fullCancelFixture.order_items.map((item) => ({
    ...item,
    status: "cancelled",
  }));
  const fullCancel = analyzePartialCancellationV2(fullCancelFixture);
  assert.equal(fullCancel.cancellationCandidate, "full_cancel");
  assert.equal(fullCancel.cancellationConsistency, "consistent");
  assert.equal(fullCancel.outcome, "stop_indeterminate");

  let fetchCount = 0;
  let cleared = false;
  const responseText = JSON.stringify({ order: partialCancelFixture });
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        assert.equal(cleared, false);
        controller.enqueue(new TextEncoder().encode(responseText));
        controller.close();
      },
    })
  );
  const cliOutcome = await runPartialCancelDiagnostic({
    environment: {
      APP_ENVIRONMENT: "development",
      BASE_DATA_MODE: "readonly",
      BASE_READONLY_ACCESS_TOKEN: "fixture-token-never-output",
    },
    argv: ["node", "diagnose-partial-cancel.mjs"],
    readOrderId: async () => "fixture-order-id",
    fetchImpl: async (url, options) => {
      fetchCount += 1;
      assert.equal(url, `${BASE_ORDER_DETAIL_URL}/fixture-order-id`);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      assert.equal(options.headers.Authorization, "Bearer fixture-token-never-output");
      return response;
    },
    setTimeoutImpl: () => ({ fixed: true }),
    clearTimeoutImpl: () => {
      cleared = true;
    },
  });
  assert.equal(fetchCount, 1);
  assert.equal(cleared, true);
  assert.equal(cliOutcome.exitCode, CLI_EXIT_CODES.PASS_ENUM_COMPLETE);
  const serialized = serializeCliOutcome(cliOutcome);
  assert.equal(serialized.stderr, "");
  assert.equal(serialized.stdout.split("\n").length, 2);
  assert.ok(Buffer.byteLength(serialized.stdout, "utf8") <= 16_384);
  assert.equal(serialized.stdout.includes("fixture-token-never-output"), false);
  assert.equal(serialized.stdout.includes("fixture-order-id"), false);
  assert.equal(serialized.stdout.includes("MUST_NOT_APPEAR_IN_OUTPUT"), false);

  const tooLargeByHeader = await runPartialCancelDiagnostic({
    environment: {
      APP_ENVIRONMENT: "development",
      BASE_DATA_MODE: "readonly",
      BASE_READONLY_ACCESS_TOKEN: "fixture",
    },
    argv: ["node", "script"],
    readOrderId: async () => "fixture",
    fetchImpl: async () =>
      new Response("{}", {
        headers: { "content-length": String(HTTP_RESPONSE_MAX_BYTES + 1) },
      }),
  });
  assert.deepEqual(serializeCliOutcome(tooLargeByHeader), {
    stdout: "",
    stderr: "STOP_RESPONSE_TOO_LARGE\n",
    exitCode: CLI_EXIT_CODES.STOP_RESPONSE_TOO_LARGE,
  });

  const forbiddenEnvironment = await runPartialCancelDiagnostic({
    environment: {
      APP_ENVIRONMENT: "development",
      BASE_DATA_MODE: "readonly",
      BASE_READONLY_ACCESS_TOKEN: "fixture",
      BASE_API_TOKEN: "must-not-be-read-or-used",
    },
    argv: ["node", "script"],
    readOrderId: async () => {
      throw new Error("must stop before input");
    },
    fetchImpl: async () => {
      throw new Error("must stop before fetch");
    },
  });
  assert.equal(forbiddenEnvironment.stderrCode, "STOP_RUNTIME_BOUNDARY");

  const tooLargeByStream = await runPartialCancelDiagnostic({
    environment: {
      APP_ENVIRONMENT: "development",
      BASE_DATA_MODE: "readonly",
      BASE_READONLY_ACCESS_TOKEN: "fixture",
    },
    argv: ["node", "script"],
    readOrderId: async () => "fixture",
    responseMaximumBytes: 8,
    fetchImpl: async () => new Response("123456789"),
  });
  assert.equal(tooLargeByStream.stderrCode, "STOP_RESPONSE_TOO_LARGE");

  const invalidJson = await runPartialCancelDiagnostic({
    environment: {
      APP_ENVIRONMENT: "development",
      BASE_DATA_MODE: "readonly",
      BASE_READONLY_ACCESS_TOKEN: "fixture",
    },
    argv: ["node", "script"],
    readOrderId: async () => "fixture",
    fetchImpl: async () => new Response("not-json"),
  });
  assert.equal(invalidJson.stderrCode, "STOP_RESPONSE_BODY");

  const httpFailure = await runPartialCancelDiagnostic({
    environment: {
      APP_ENVIRONMENT: "development",
      BASE_DATA_MODE: "readonly",
      BASE_READONLY_ACCESS_TOKEN: "fixture",
    },
    argv: ["node", "script"],
    readOrderId: async () => "fixture",
    fetchImpl: async () => new Response("{}", { status: 500 }),
  });
  assert.equal(httpFailure.stderrCode, "STOP_HTTP");

  const transportFailure = await runPartialCancelDiagnostic({
    environment: {
      APP_ENVIRONMENT: "development",
      BASE_DATA_MODE: "readonly",
      BASE_READONLY_ACCESS_TOKEN: "fixture",
    },
    argv: ["node", "script"],
    readOrderId: async () => "fixture",
    fetchImpl: async () => {
      throw new Error("MUST_NOT_APPEAR");
    },
  });
  assert.equal(transportFailure.stderrCode, "STOP_TRANSPORT");
  assert.equal(JSON.stringify(transportFailure).includes("MUST_NOT_APPEAR"), false);

  const timedOut = await runPartialCancelDiagnostic({
    environment: {
      APP_ENVIRONMENT: "development",
      BASE_DATA_MODE: "readonly",
      BASE_READONLY_ACCESS_TOKEN: "fixture",
    },
    argv: ["node", "script"],
    readOrderId: async () => "fixture",
    requestTimeoutMs: 5,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  });
  assert.equal(timedOut.stderrCode, "STOP_TIMEOUT");

  let headersReturned = false;
  let bodyReadStarted = false;
  let bodyAbortObserved = false;
  const bodyReadTimedOut = await runPartialCancelDiagnostic({
    environment: {
      APP_ENVIRONMENT: "development",
      BASE_DATA_MODE: "readonly",
      BASE_READONLY_ACCESS_TOKEN: "fixture",
    },
    argv: ["node", "script"],
    readOrderId: async () => "fixture",
    requestTimeoutMs: 5,
    fetchImpl: async (_url, { signal }) => {
      headersReturned = true;
      return {
        ok: true,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: () => {
              bodyReadStarted = true;
              return new Promise((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    bodyAbortObserved = true;
                    reject(new Error("fixture body read aborted"));
                  },
                  { once: true }
                );
              });
            },
            releaseLock: () => {},
          }),
        },
      };
    },
  });
  assert.equal(headersReturned, true);
  assert.equal(bodyReadStarted, true);
  assert.equal(bodyAbortObserved, true);
  assert.equal(bodyReadTimedOut.stderrCode, "STOP_TIMEOUT");

  class FakeTtyInput extends EventEmitter {
    constructor() {
      super();
      this.isTTY = true;
      this.rawModes = [];
      this.encodings = [];
      this.resumed = false;
      this.paused = false;
    }

    setRawMode(value) {
      this.rawModes.push(value);
    }

    resume() {
      this.resumed = true;
    }

    pause() {
      this.paused = true;
    }

    setEncoding(value) {
      this.encodings.push(value);
    }
  }

  const fakeTty = new FakeTtyInput();
  let stdoutWriteCount = 0;
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = () => {
    stdoutWriteCount += 1;
    return true;
  };
  let hiddenOrderId;
  try {
    const hiddenOrderIdPromise = readHiddenOrderId(fakeTty);
    for (const character of "fixture-order-id") {
      fakeTty.emit("keypress", character, { name: character });
    }
    fakeTty.emit("keypress", "\r", { name: "return" });
    hiddenOrderId = await hiddenOrderIdPromise;
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  assert.equal(hiddenOrderId, "fixture-order-id");
  assert.deepEqual(fakeTty.rawModes, [true, false]);
  assert.equal(fakeTty.resumed, true);
  assert.equal(fakeTty.paused, true);
  assert.deepEqual(fakeTty.encodings, ["utf8"]);
  assert.equal(stdoutWriteCount, 0);

  const pipedCli = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      "--experimental-specifier-resolution=node",
      "scripts/diagnose-partial-cancel.mjs",
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        APP_ENVIRONMENT: "development",
        BASE_DATA_MODE: "readonly",
        BASE_READONLY_ACCESS_TOKEN: "fixture",
      },
      input: "fixture-order-id\n",
      encoding: "utf8",
      windowsHide: true,
    }
  );
  assert.equal(pipedCli.status, CLI_EXIT_CODES.STOP_INPUT);
  assert.equal(pipedCli.stdout, "");
  assert.equal(pipedCli.stderr, "STOP_INPUT\n");

  console.log("partial cancel diagnostic tests passed");
} finally {
  globalThis.fetch = forbiddenRealFetch;
}

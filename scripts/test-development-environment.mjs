import assert from "node:assert/strict";
import {
  assertBaseRequestAllowed,
  resolveRuntimeConfig,
} from "../lib/runtime-mode.ts";
import { MemoryRedis } from "../lib/memory-redis.ts";
import { analyzePartialCancellation } from "../lib/partial-cancel-diagnostic.ts";

assert.deepEqual(
  resolveRuntimeConfig({
    APP_ENVIRONMENT: "local",
    BASE_DATA_MODE: "mock",
    APP_STORE_MODE: "memory",
  }),
  {
    appEnvironment: "local",
    baseDataMode: "mock",
    appStoreMode: "memory",
  }
);
assert.deepEqual(
  resolveRuntimeConfig({
    APP_ENVIRONMENT: "development",
    BASE_DATA_MODE: "readonly",
    APP_STORE_MODE: "upstash",
  }),
  {
    appEnvironment: "development",
    baseDataMode: "readonly",
    appStoreMode: "upstash",
  }
);
assert.deepEqual(
  resolveRuntimeConfig({
    APP_ENVIRONMENT: "production",
    BASE_DATA_MODE: "production",
    APP_STORE_MODE: "upstash",
  }),
  {
    appEnvironment: "production",
    baseDataMode: "production",
    appStoreMode: "upstash",
  }
);

assert.throws(() => resolveRuntimeConfig({}), /APP_ENVIRONMENT is required/);
assert.throws(
  () =>
    resolveRuntimeConfig({
      APP_ENVIRONMENT: "local",
      BASE_DATA_MODE: "production",
      APP_STORE_MODE: "memory",
    }),
  /Unsafe mode combination/
);
assert.throws(
  () => assertBaseRequestAllowed("mock", "GET"),
  /network access is disabled/
);
assert.throws(
  () => assertBaseRequestAllowed("readonly", "POST"),
  /POST is disabled/
);
assert.doesNotThrow(() => assertBaseRequestAllowed("readonly", "GET"));

let blockedExternalFetchCalled = false;
try {
  assertBaseRequestAllowed("mock", "GET");
  blockedExternalFetchCalled = true;
} catch {
  // mock modeの停止線が外部fetch相当処理より先に発動することを確認する。
}
assert.equal(blockedExternalFetchCalled, false);

let now = 1_000;
const memory = new MemoryRedis(() => now);
assert.equal(await memory.set("plain", "value"), "OK");
assert.equal(await memory.get("plain"), "value");
assert.equal(await memory.set("plain", "other", { nx: true }), null);
assert.equal(await memory.sadd("members", "a", "b", "a"), 2);
assert.deepEqual((await memory.smembers("members")).sort(), ["a", "b"]);
assert.equal(await memory.srem("members", "a"), 1);
assert.equal(await memory.set("temporary", "value", { ex: 2 }), "OK");
now += 2_001;
assert.equal(await memory.get("temporary"), null);

const pipeline = memory.pipeline();
pipeline.set("pipeline:value", "ok");
pipeline.get("pipeline:value");
pipeline.sadd("pipeline:set", "x");
assert.deepEqual(await pipeline.exec(), ["OK", "ok", 1]);

const normal = analyzePartialCancellation({
  cancelled: null,
  total: 1_100,
  shipping_lines: [{ shipping_fee: 100 }],
  order_items: [
    {
      status: "ordered",
      price: 500,
      amount: 2,
      total: 1_000,
      item_total: 1_000,
      option_total: 0,
      options: [],
      consumption_tax_rate: 10,
    },
  ],
});
assert.equal(normal.cancellationCandidate, "normal");
assert.equal(normal.amountRelation, "explained");
assert.equal(normal.taxRateComposition, "10_only");

const partial = analyzePartialCancellation({
  cancelled: null,
  total: 1_080,
  shipping_lines: [{ shipping_fee: 100 }],
  order_discount: { discount: 20 },
  order_items: [
    {
      status: "ordered",
      price: 500,
      amount: 2,
      total: 1_000,
      item_total: 1_000,
      option_total: 0,
      options: [],
      consumption_tax_rate: 10,
    },
    {
      status: "cancelled",
      price: 500,
      amount: 1,
      total: 500,
      item_total: 500,
      option_total: 0,
      options: [],
      consumption_tax_rate: 8,
    },
  ],
});
assert.equal(partial.cancellationCandidate, "partial_cancel");
assert.equal(partial.cancelledItemsRemainInOrderItems, "yes");
assert.equal(partial.amountRelation, "explained");
assert.equal(partial.taxRateComposition, "mixed_8_10");

const full = analyzePartialCancellation({
  cancelled: 1,
  total: 0,
  shipping_fee: 0,
  order_items: [
    { status: "cancelled", price: 1_000, amount: 1, consumption_tax_rate: 8 },
  ],
});
assert.equal(full.cancellationCandidate, "full_cancel");
assert.equal(full.amountRelation, "explained");

const paidOptions = analyzePartialCancellation({
  cancelled: null,
  total: 7_100,
  shipping_fee: 100,
  order_items: [
    {
      status: "ordered",
      price: 2_000,
      amount: 2,
      total: 7_000,
      item_total: 4_000,
      option_total: 3_000,
      options: [{ price: 500 }, { price: 1_000 }],
      consumption_tax_rate: 10,
    },
  ],
});
assert.equal(paidOptions.amountRelation, "explained");

const paidOptionsFromComponents = analyzePartialCancellation({
  cancelled: null,
  total: 7_100,
  shipping_fee: 100,
  order_items: [
    {
      status: "ordered",
      price: 2_000,
      amount: 2,
      item_total: 4_000,
      option_total: 3_000,
      options: [{ price: 500 }, { price: 1_000 }],
      consumption_tax_rate: 10,
    },
  ],
});
assert.equal(paidOptionsFromComponents.amountRelation, "explained");

const paidOptionsFromFields = analyzePartialCancellation({
  cancelled: null,
  total: 7_100,
  shipping_fee: 100,
  order_items: [
    {
      status: "ordered",
      price: 2_000,
      amount: 2,
      options: [{ price: 500 }, { price: 1_000 }],
      consumption_tax_rate: 10,
    },
  ],
});
assert.equal(paidOptionsFromFields.amountRelation, "explained");

const itemTotalOnly = analyzePartialCancellation({
  cancelled: null,
  total: 1_000,
  order_items: [
    { status: "ordered", total: 1_000, consumption_tax_rate: 10 },
  ],
});
assert.equal(itemTotalOnly.amountRelation, "explained");

const conflictingItemTotals = analyzePartialCancellation({
  cancelled: null,
  total: 7_000,
  order_items: [
    {
      status: "ordered",
      price: 2_000,
      amount: 2,
      total: 7_000,
      item_total: 4_000,
      option_total: 3_000,
      options: [],
      consumption_tax_rate: 10,
    },
  ],
});
assert.equal(conflictingItemTotals.amountRelation, "indeterminate");

const alternateShippingRepresentations = analyzePartialCancellation({
  cancelled: null,
  total: 1_100,
  shipping_fee: 100,
  shipping_lines: [],
  order_items: [
    { status: "ordered", total: 1_000, consumption_tax_rate: 10 },
  ],
});
assert.equal(alternateShippingRepresentations.amountRelation, "indeterminate");

const unknown = analyzePartialCancellation({
  cancelled: null,
  total: 1_000,
  order_items: [
    { status: "unexpected", price: 1_000, amount: 1, consumption_tax_rate: 10 },
  ],
});
assert.equal(unknown.cancellationCandidate, "indeterminate");
assert.equal(unknown.unknownItemStatusPresent, true);
assert.equal(unknown.amountRelation, "indeterminate");

const unexplained = analyzePartialCancellation({
  cancelled: null,
  total: 999,
  shipping_fee: 0,
  order_items: [
    {
      status: "ordered",
      price: 1_000,
      amount: 1,
      total: 1_000,
      item_total: 1_000,
      option_total: 0,
      options: [],
      consumption_tax_rate: 10,
    },
  ],
});
assert.equal(unexplained.amountRelation, "unexplained_difference");

const amountIndeterminate = analyzePartialCancellation({
  cancelled: null,
  total: 1_000,
  order_items: [{ status: "ordered", consumption_tax_rate: 10 }],
});
assert.equal(amountIndeterminate.amountRelation, "indeterminate");

const optionAmountIndeterminate = analyzePartialCancellation({
  cancelled: null,
  total: 1_100,
  shipping_fee: 100,
  order_items: [
    { status: "ordered", price: 500, amount: 2, consumption_tax_rate: 10 },
  ],
});
assert.equal(optionAmountIndeterminate.amountRelation, "indeterminate");

const missingShippingIndeterminate = analyzePartialCancellation({
  cancelled: null,
  total: 1_100,
  order_items: [
    {
      status: "ordered",
      total: 1_000,
      consumption_tax_rate: 10,
    },
  ],
});
assert.equal(missingShippingIndeterminate.amountRelation, "indeterminate");

console.log("development environment tests passed");

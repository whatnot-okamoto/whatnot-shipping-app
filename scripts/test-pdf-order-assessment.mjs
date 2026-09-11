import assert from "node:assert/strict";
import {
  assessOrderForPdf,
  prepareOrderForPdf,
} from "../lib/pdf-order-assessment.ts";

function item(overrides = {}) {
  return {
    order_item_id: 1,
    item_id: 10,
    variation_id: 100,
    title: "テスト商品",
    barcode: "4900000000001",
    variation: "",
    variation_identifier: "",
    amount: 2,
    price: 1_000,
    status: "ordered",
    consumption_tax_rate: 10,
    total: 2_200,
    item_total: 2_000,
    option_total: 200,
    options: [{ price: 100 }],
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    unique_key: "TEST-ORDER",
    ordered: 1,
    cancelled: null,
    dispatched: null,
    dispatch_status: "ordered",
    payment: "creditcard",
    shipping_method: null,
    shipping_fee: 999_999,
    total: 2_970,
    first_name: "名",
    last_name: "姓",
    zip_code: "000-0000",
    prefecture: "東京都",
    address: "住所",
    address2: "",
    tel: "000",
    remark: "",
    modified: 1,
    terminated: false,
    order_receiver: null,
    order_items: [item()],
    shipping_lines: [
      { order_item_ids: ["1"], shipping_method: "宅配便", shipping_fee: 770 },
    ],
    ...overrides,
  };
}

const normal = prepareOrderForPdf(order());
assert.equal(normal.assessment.generationOutcome, "eligible");
assert.equal(normal.assessment.cancellationState, "normal");
assert.equal(normal.order.order_items[0].price, 1_100);
assert.equal(normal.order.order_items[0].total, 2_200);
assert.equal(normal.order.shipping_lines[0].shipping_fee, 770);

const topLevelCancellationDoesNotOverrideItems = assessOrderForPdf(
  order({ cancelled: 123, order_items: [item({ status: "ordered" })] })
);
assert.equal(topLevelCancellationDoesNotOverrideItems.cancellationState, "normal");
assert.equal(topLevelCancellationDoesNotOverrideItems.generationOutcome, "eligible");

const partial = order({
  order_items: [
    item({ order_item_id: 1, status: "dispatched" }),
    item({ order_item_id: 2, status: "cancelled", consumption_tax_rate: null }),
  ],
  shipping_lines: [
    {
      order_item_ids: ["1", "2"],
      shipping_method: "宅配便",
      shipping_fee: 770,
    },
  ],
});
const preparedPartial = prepareOrderForPdf(partial);
assert.equal(preparedPartial.assessment.generationOutcome, "eligible");
assert.equal(preparedPartial.assessment.cancellationState, "partial_cancel");
assert.deepEqual(
  preparedPartial.order.order_items.map((candidate) => candidate.order_item_id),
  [1]
);
assert.equal(preparedPartial.order.shipping_lines[0].shipping_fee, 770);

const full = assessOrderForPdf(
  order({ order_items: [item({ status: "cancelled" })] })
);
assert.equal(full.cancellationState, "full_cancel");
assert.equal(full.generationOutcome, "blocked");
assert.deepEqual(full.issues, ["full_cancel"]);

const unknownStatus = assessOrderForPdf(
  order({ order_items: [item({ status: "future_status" })] })
);
assert.equal(unknownStatus.cancellationState, "cancellation_state_unknown");
assert(unknownStatus.issues.includes("cancellation_state_unknown"));

const directOnlyItem = item({
  total: 2_000,
  item_total: undefined,
  option_total: undefined,
  options: undefined,
});
delete directOnlyItem.item_total;
delete directOnlyItem.option_total;
delete directOnlyItem.options;
const directOnly = prepareOrderForPdf(order({ order_items: [directOnlyItem] }));
assert.equal(directOnly.assessment.generationOutcome, "eligible");
assert.equal(directOnly.order.order_items[0].price, 1_000);

const directWithoutPriceItem = item({ price: undefined });
delete directWithoutPriceItem.price;
delete directWithoutPriceItem.item_total;
delete directWithoutPriceItem.option_total;
delete directWithoutPriceItem.options;
const directWithoutPrice = prepareOrderForPdf(
  order({ order_items: [directWithoutPriceItem] })
);
assert.equal(
  directWithoutPrice.assessment.generationOutcome,
  "eligible",
  "a missing helper price must not block a complete divisible total path"
);
assert.equal(directWithoutPrice.order.order_items[0].price, 1_100);

const componentOnlyItem = item({ total: undefined, options: undefined });
delete componentOnlyItem.total;
delete componentOnlyItem.options;
const componentOnly = prepareOrderForPdf(order({ order_items: [componentOnlyItem] }));
assert.equal(componentOnly.assessment.generationOutcome, "eligible");
assert.equal(componentOnly.order.order_items[0].price, 1_100);

const reconstructedOnlyItem = item({ total: undefined, item_total: undefined, option_total: undefined });
delete reconstructedOnlyItem.total;
delete reconstructedOnlyItem.item_total;
delete reconstructedOnlyItem.option_total;
const reconstructedOnly = prepareOrderForPdf(order({ order_items: [reconstructedOnlyItem] }));
assert.equal(reconstructedOnly.assessment.generationOutcome, "eligible");
assert.equal(reconstructedOnly.order.order_items[0].total, 2_200);

const incompleteHelperItem = item({ total: undefined, option_total: undefined });
delete incompleteHelperItem.total;
delete incompleteHelperItem.option_total;
const incompleteHelper = prepareOrderForPdf(order({ order_items: [incompleteHelperItem] }));
assert.equal(
  incompleteHelper.assessment.generationOutcome,
  "eligible",
  "an incomplete helper path must not block a complete reconstructed path"
);

const inconsistent = assessOrderForPdf(
  order({ order_items: [item({ total: 2_201 })] })
);
assert(inconsistent.issues.includes("amount_inconsistent"));

const zeroShipping = assessOrderForPdf(
  order({ shipping_fee: 770, shipping_lines: [] })
);
assert(zeroShipping.issues.includes("shipping_data_unknown"));
assert.equal(zeroShipping.generationOutcome, "blocked");

const multipleShipping = assessOrderForPdf(
  order({
    shipping_lines: [
      { order_item_ids: ["1"], shipping_method: "A", shipping_fee: 500 },
      { order_item_ids: ["1"], shipping_method: "B", shipping_fee: 270 },
    ],
  })
);
assert(multipleShipping.issues.includes("multiple_shipping_lines_unsupported"));

const unitUnknownItem = item({ amount: 3, total: 1_000 });
delete unitUnknownItem.item_total;
delete unitUnknownItem.option_total;
delete unitUnknownItem.options;
const unitUnknown = assessOrderForPdf(order({ order_items: [unitUnknownItem] }));
assert(unitUnknown.issues.includes("unit_price_unknown"));

const invalidAmount = assessOrderForPdf(
  order({ order_items: [item({ amount: Number.MAX_SAFE_INTEGER })] })
);
assert(invalidAmount.issues.includes("order_data_invalid"));

console.log("pdf order assessment tests passed");

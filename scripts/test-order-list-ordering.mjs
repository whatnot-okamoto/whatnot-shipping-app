import assert from "node:assert/strict";
import {
  compareOrdersNewestFirst,
  resolveOrderedTimestamp,
} from "../lib/order-list-ordering.ts";
import {
  getStaffReviewSnapshotChanges,
  hasStaffReviewSnapshotDiff,
  needsOrderedTimestampRepair,
  shouldPromotePendingSnapshot,
} from "../lib/order-snapshot-diff.ts";

const legacySnapshot = {
  unique_key: "ORDER-B",
  bundle_group_id: "bg-test",
  receiver_name: "テスト",
  order_date: "2026-09-05",
  shipping_method_name: "宅配便",
  shipping_fee: 770,
  shipping_lines_count: 1,
  has_multiple_shipping_lines: false,
  shipping_category: "delivery",
  remark: "",
  item_count: 1,
  items_summary: "商品A",
};

// 既存snapshotに時刻がなくても、一覧取得済みのBASE orderedを正にできる。
assert.equal(resolveOrderedTimestamp(200, legacySnapshot.ordered_timestamp), 200);
assert.equal(resolveOrderedTimestamp(undefined, 150), 150);
assert.equal(resolveOrderedTimestamp(undefined, undefined), 0);
assert.equal(resolveOrderedTimestamp(201, 999), 201, "BASE ordered must win");
assert.equal(resolveOrderedTimestamp(-1, undefined), 0);
assert.equal(resolveOrderedTimestamp(1.5, undefined), 0);

// 要確認フラグ等には依存せず、全注文を時刻降順で並べる。
const sorted = [
  { unique_key: "ORDER-OLD-ALERT", ordered_timestamp: 100, hold_flag: true },
  { unique_key: "ORDER-B", ordered_timestamp: 200, hold_flag: false },
  { unique_key: "ORDER-A", ordered_timestamp: 200, needs_initialization: true },
  { unique_key: "ORDER-MISSING", ordered_timestamp: 0, hold_flag: true },
].sort(compareOrdersNewestFirst);
assert.deepEqual(
  sorted.map((order) => order.unique_key),
  ["ORDER-A", "ORDER-B", "ORDER-OLD-ALERT", "ORDER-MISSING"]
);

// 時刻補完だけではスタッフ向け業務差分にならないが、snapshot昇格は必要。
const timestampOnlyPending = {
  ...legacySnapshot,
  ordered_timestamp: 200,
};
assert.deepEqual(getStaffReviewSnapshotChanges(legacySnapshot, timestampOnlyPending), {
  itemChanged: false,
  feeChanged: false,
  shippingChanged: false,
});
assert.equal(hasStaffReviewSnapshotDiff(legacySnapshot, timestampOnlyPending), false);
assert.equal(needsOrderedTimestampRepair(legacySnapshot, timestampOnlyPending), true);
assert.equal(shouldPromotePendingSnapshot(legacySnapshot, timestampOnlyPending), true);

// 補完済みの同一時刻は再昇格しない。時刻補正は業務差分なしで昇格する。
const repairedSnapshot = { ...legacySnapshot, ordered_timestamp: 200 };
assert.equal(needsOrderedTimestampRepair(repairedSnapshot, timestampOnlyPending), false);
assert.equal(shouldPromotePendingSnapshot(repairedSnapshot, timestampOnlyPending), false);
const correctedTimestamp = { ...timestampOnlyPending, ordered_timestamp: 201 };
assert.equal(hasStaffReviewSnapshotDiff(repairedSnapshot, correctedTimestamp), false);
assert.equal(needsOrderedTimestampRepair(repairedSnapshot, correctedTimestamp), true);
assert.equal(shouldPromotePendingSnapshot(repairedSnapshot, correctedTimestamp), true);

// pendingに正確な時刻がない場合、時刻だけを理由に既存snapshotを壊さない。
assert.equal(needsOrderedTimestampRepair(repairedSnapshot, legacySnapshot), false);
assert.equal(
  needsOrderedTimestampRepair(repairedSnapshot, {
    ...legacySnapshot,
    ordered_timestamp: -1,
  }),
  false
);

// 既存5項目の業務差分は従来どおり検出し、昇格対象になる。
for (const changedPending of [
  { ...timestampOnlyPending, item_count: 2 },
  { ...timestampOnlyPending, items_summary: "商品B" },
  { ...timestampOnlyPending, shipping_fee: 880 },
  { ...timestampOnlyPending, shipping_method_name: "ネコポス" },
  { ...timestampOnlyPending, shipping_lines_count: 2 },
]) {
  assert.equal(hasStaffReviewSnapshotDiff(timestampOnlyPending, changedPending), true);
  assert.equal(shouldPromotePendingSnapshot(timestampOnlyPending, changedPending), true);
}

console.log("order list ordering tests: PASS");

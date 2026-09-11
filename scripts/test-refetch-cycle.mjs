import assert from "node:assert/strict";
import { findSelectionVerificationFailures } from "../lib/refetch-cycle.ts";
import {
  getStaffReviewSnapshotChanges,
  shouldPromotePendingSnapshot,
} from "../lib/order-snapshot-diff.ts";

function snapshot(uniqueKey, cycleId, overrides = {}) {
  return {
    unique_key: uniqueKey,
    bundle_group_id: `bg-${uniqueKey}`,
    receiver_name: "確認用",
    order_date: "2026-09-11",
    ordered_timestamp: 1,
    shipping_method_name: "宅配便",
    shipping_fee: 770,
    shipping_lines_count: 1,
    has_multiple_shipping_lines: false,
    shipping_category: "delivery",
    remark: "",
    item_count: 1,
    items_summary: "商品",
    pdf_verification_cycle_id: cycleId,
    open_order_presence: "present",
    cancellation_state: "normal",
    pdf_generation_outcome: "eligible",
    pdf_issue_codes: [],
    ...overrides,
  };
}

function state(cycleId, orderResults) {
  return {
    refetch_done_flag: true,
    diff_confirmed_flag: true,
    refetched_at: "2026-09-11T00:00:00.000Z",
    has_new_uninitialized: false,
    refetch_cycle_id: cycleId,
    refetch_result: Object.values(orderResults).some(
      (result) => result.status === "fetch_failed"
    )
      ? "partial"
      : "complete",
    order_results: orderResults,
  };
}

const eligible = { status: "verified_eligible", cancellation_state: "normal", issues: [] };

const cycleA = state("cycle-a", { FAILED: eligible });
assert.deepEqual(
  findSelectionVerificationFailures(
    cycleA,
    new Map([["FAILED", snapshot("FAILED", "cycle-a")]]),
    ["FAILED"]
  ),
  []
);

const cycleB = state("cycle-b", {
  FAILED: { status: "fetch_failed", issues: [] },
  NORMAL: eligible,
});
const cycleBSnapshots = new Map([
  ["FAILED", snapshot("FAILED", "cycle-a")],
  ["NORMAL", snapshot("NORMAL", "cycle-b")],
]);
assert.equal(
  findSelectionVerificationFailures(cycleB, cycleBSnapshots, ["FAILED"])[0].reason,
  "fetch_failed",
  "a prior-cycle eligible snapshot must not pass a current fetch failure"
);
assert.deepEqual(
  findSelectionVerificationFailures(cycleB, cycleBSnapshots, ["NORMAL"]),
  [],
  "a confirmed normal order in another U2 remains selectable"
);
assert.equal(
  findSelectionVerificationFailures(cycleB, cycleBSnapshots, ["NORMAL", "FAILED"])[0].reason,
  "fetch_failed",
  "U2 expansion must not reintroduce a failed order"
);
assert.equal(
  findSelectionVerificationFailures(
    state("cycle-b", { STALE: eligible }),
    new Map([["STALE", snapshot("STALE", "cycle-a")]]),
    ["STALE"]
  )[0].reason,
  "not_verified_in_current_cycle",
  "a current result must also have a snapshot promoted for the same cycle"
);

assert.equal(
  findSelectionVerificationFailures(
    state("cycle-b", {
      BLOCKED: {
        status: "verified_blocked",
        cancellation_state: "full_cancel",
        issues: ["full_cancel"],
      },
    }),
    new Map([
      [
        "BLOCKED",
        snapshot("BLOCKED", "cycle-b", {
          cancellation_state: "full_cancel",
          pdf_generation_outcome: "blocked",
          pdf_issue_codes: ["full_cancel"],
        }),
      ],
    ]),
    ["BLOCKED"]
  )[0].reason,
  "blocked"
);

const notOpenState = state("cycle-b", {
  NORMAL: eligible,
  GONE: { status: "not_in_open_orders", issues: ["not_in_open_orders"] },
});
const notOpenSnapshots = new Map([
  ["NORMAL", snapshot("NORMAL", "cycle-b")],
  [
    "GONE",
    snapshot("GONE", "cycle-b", {
      open_order_presence: "not_in_open_orders",
      pdf_generation_outcome: "blocked",
      pdf_issue_codes: ["not_in_open_orders"],
    }),
  ],
]);
assert.equal(
  findSelectionVerificationFailures(notOpenState, notOpenSnapshots, ["NORMAL", "GONE"])[0].reason,
  "not_in_open_orders"
);

const cycleC = state("cycle-c", { FAILED: eligible });
assert.deepEqual(
  findSelectionVerificationFailures(
    cycleC,
    new Map([["FAILED", snapshot("FAILED", "cycle-c")]]),
    ["FAILED"]
  ),
  [],
  "a successful retry becomes selectable after confirmation"
);

const legacy = snapshot("NORMAL", undefined);
delete legacy.pdf_verification_cycle_id;
delete legacy.open_order_presence;
delete legacy.cancellation_state;
delete legacy.pdf_generation_outcome;
delete legacy.pdf_issue_codes;
const completed = snapshot("NORMAL", "cycle-b");
assert.deepEqual(getStaffReviewSnapshotChanges(legacy, completed), {
  itemChanged: false,
  feeChanged: false,
  shippingChanged: false,
});
assert.equal(
  shouldPromotePendingSnapshot(legacy, completed),
  true,
  "schema-only PDF verification fields must promote after diff confirmation"
);

console.log("refetch cycle tests passed");

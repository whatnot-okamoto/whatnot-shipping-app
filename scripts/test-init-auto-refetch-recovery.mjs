import assert from "node:assert/strict";

process.env.APP_ENVIRONMENT = "local";
process.env.BASE_DATA_MODE = "mock";
process.env.APP_STORE_MODE = "memory";

const { FIXTURE_DATA } = await import("../lib/pdf-fixture-data.ts");
const { redis } = await import("../lib/upstash.ts");
const { initializeOrderData } = await import("../lib/order-store.ts");
const {
  WORKFLOW_LEASE_KEY,
  acquireWorkflowLease,
  releaseWorkflowLease,
} = await import("../lib/workflow-operation-lease.ts");
const baseFake = await import("./fakes/workflow-base-api.ts");
const initRoute = await import("../app/api/orders/init/route.ts");
const refetchRoute = await import("../app/api/orders/refetch/route.ts");
const diffConfirmRoute = await import("../app/api/orders/diff-confirm/route.ts");
const orderListRoute = await import("../app/api/orders/list/route.ts");

async function clearMemoryRedis() {
  const keys = await redis.keys("*");
  if (keys.length > 0) await redis.del(...keys);
}

function makeOrder(uniqueKey, itemId) {
  const order = structuredClone(FIXTURE_DATA["F-01"].order);
  order.unique_key = uniqueKey;
  order.dispatch_status = "ordered";
  order.dispatched = null;
  order.terminated = false;
  order.order_items[0].order_item_id = itemId;
  order.order_items[0].item_id = itemId * 100;
  order.shipping_lines[0].order_item_ids = [String(itemId)];
  return order;
}

async function post(route, path, body) {
  return route.POST(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function readRefetchState() {
  const raw = await redis.get("orders:refetch_state");
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function prepareAbsencesAndNewOrders({
  historicalCount = 23,
  newCount = 1,
  scenario = "CURRENT",
} = {}) {
  await clearMemoryRedis();
  const historicalOrders = Array.from({ length: historicalCount }, (_, index) =>
    makeOrder(`TEST-${scenario}-HISTORICAL-${index + 1}`, 41_000 + index)
  );
  const newOrders = Array.from({ length: newCount }, (_, index) =>
    makeOrder(`TEST-${scenario}-NEW-${index + 1}`, 42_000 + index)
  );

  await initializeOrderData(historicalOrders);
  baseFake.setWorkflowBaseOrders(historicalOrders);

  const baselineRefetch = await withinGuard(
    post(refetchRoute, "/api/orders/refetch"),
    "baseline-refetch",
    2_000
  );
  assert.equal(baselineRefetch.status, 200);
  const baselineBody = await baselineRefetch.json();
  assert.equal(baselineBody.success, true);
  const baselineConfirm = await withinGuard(
    post(diffConfirmRoute, "/api/orders/diff-confirm", {
      refetch_cycle_id: baselineBody.diff_result.refetch_cycle_id,
    }),
    "baseline-confirm",
    2_000
  );
  assert.equal(baselineConfirm.status, 200);
  assert.equal((await baselineConfirm.json()).success, true);

  baseFake.setWorkflowBaseOrders(newOrders);
  const currentRefetch = await withinGuard(
    post(refetchRoute, "/api/orders/refetch"),
    "current-refetch",
    2_000
  );
  assert.equal(currentRefetch.status, 200);
  const currentBody = await currentRefetch.json();
  assert.equal(currentBody.success, true);
  assert.equal(currentBody.diff_result.first_absence_count, historicalCount);
  assert.equal(currentBody.diff_result.has_new_uninitialized, true);
  assert.equal(currentBody.diff_result.new_uninitialized_count, newCount);

  const state = await readRefetchState();
  assert.equal(state.phase, "awaiting_initialization");
  assert.equal(state.post_init_refetch_ready, false);
  return { newOrders, cycleId: currentBody.diff_result.refetch_cycle_id };
}

async function withinGuard(promise, scenario, timeoutMs = 250) {
  let guardTimer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        guardTimer = setTimeout(
          () => reject(new Error(`${scenario} exceeded ${timeoutMs}ms guard`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(guardTimer);
  }
}

// Exact happy path: confirmed baseline -> 23 first absences + one new order ->
// init -> authorized automatic refetch -> next review state.
let prepared = await prepareAbsencesAndNewOrders();
const initResponse = await withinGuard(
  post(initRoute, "/api/orders/init", {
    refetch_cycle_id: prepared.cycleId,
  }),
  "successful-init",
  2_000
);
assert.equal(initResponse.status, 200);
assert.equal((await initResponse.json()).success, true);
assert.equal(baseFake.getWorkflowDetailCallCount(), 1);

const readyState = await readRefetchState();
assert.equal(readyState.post_init_refetch_ready, true);
assert.equal(readyState.phase, "awaiting_initialization");

const automaticRefetch = await withinGuard(
  post(refetchRoute, "/api/orders/refetch", {
    source_refetch_cycle_id: prepared.cycleId,
  }),
  "successful-automatic-refetch",
  2_000
);
assert.equal(automaticRefetch.status, 200);
const automaticBody = await automaticRefetch.json();
assert.equal(automaticBody.success, true);
assert.equal(automaticBody.diff_result.has_new_uninitialized, false);
assert.equal(automaticBody.diff_result.new_uninitialized_count, 0);
assert.equal((await readRefetchState()).phase, "awaiting_review");
assert.equal(baseFake.getWorkflowDetailCallCount(), 2);
assert.ok(
  (await redis.smembers("index:orders")).includes(prepared.newOrders[0].unique_key)
);
assert.equal(await redis.get(WORKFLOW_LEASE_KEY), null);

// RED: list, each detail, and the whole BASE phase need separate budgets.
// Several individually healthy requests must not share one short signal.
prepared = await prepareAbsencesAndNewOrders({
  historicalCount: 2,
  newCount: 5,
  scenario: "SEPARATE-BUDGETS",
});
baseFake.setWorkflowDetailDelay(15);
const nativeAbortTimeoutForBudgets = AbortSignal.timeout;
AbortSignal.timeout = (timeoutMs) =>
  nativeAbortTimeoutForBudgets(
    timeoutMs === initRoute.INIT_BASE_DETAIL_TIMEOUT_MS
      ? 25
      : timeoutMs === initRoute.INIT_BASE_LIST_TIMEOUT_MS
        ? 50
        : timeoutMs === initRoute.INIT_BASE_PHASE_TIMEOUT_MS
          ? 150
          : 25
  );
try {
  const separateBudgetResponse = await withinGuard(
    post(initRoute, "/api/orders/init", {
      refetch_cycle_id: prepared.cycleId,
    }),
    "separate-init-budgets",
    500
  );
  assert.equal((await separateBudgetResponse.json()).success, true);
  assert.equal(baseFake.getWorkflowDetailCallCount(), 5);
} finally {
  AbortSignal.timeout = nativeAbortTimeoutForBudgets;
}

assert.equal(initRoute.maxDuration, 300);
assert.ok(initRoute.INIT_BASE_LIST_TIMEOUT_MS > 15_000);
assert.ok(initRoute.INIT_BASE_DETAIL_TIMEOUT_MS > 15_000);
assert.ok(
  initRoute.INIT_BASE_PHASE_TIMEOUT_MS < initRoute.maxDuration * 1_000,
  "the BASE phase must leave time inside the route runtime ceiling for Redis persistence and response"
);

// RED: index:orders is a completion marker only for the current ordered write
// path. Legacy or externally damaged state may retain the index while U1,
// snapshot, or U4 is absent. Such an order must be fetched and repaired rather
// than skipped and marked ready for automatic refetch.
prepared = await prepareAbsencesAndNewOrders({
  historicalCount: 1,
  newCount: 1,
  scenario: "INDEX-ONLY",
});
const indexOnlyOrder = prepared.newOrders[0];
await redis.sadd("index:orders", indexOnlyOrder.unique_key);
const indexOnlyDetailCalls = baseFake.getWorkflowDetailCallCount();
const indexOnlyRepairResponse = await withinGuard(
  post(initRoute, "/api/orders/init", {
    refetch_cycle_id: prepared.cycleId,
  }),
  "index-only-init-repair",
  2_000
);
const indexOnlyRepairBody = await indexOnlyRepairResponse.json();
assert.equal(indexOnlyRepairBody.success, true);
assert.equal(indexOnlyRepairBody.initialized, 1);
assert.equal(
  baseFake.getWorkflowDetailCallCount() - indexOnlyDetailCalls,
  1
);
assert.ok(await redis.get(`order:${indexOnlyOrder.unique_key}`));
assert.ok(await redis.get(`order_snapshot:${indexOnlyOrder.unique_key}`));
assert.ok(await redis.get(`picking:${indexOnlyOrder.order_items[0].order_item_id}`));
assert.equal((await readRefetchState()).post_init_refetch_ready, true);
const indexOnlyAutomaticRefetch = await withinGuard(
  post(refetchRoute, "/api/orders/refetch", {
    source_refetch_cycle_id: prepared.cycleId,
  }),
  "index-only-repair-auto-refetch",
  2_000
);
const indexOnlyAutomaticBody = await indexOnlyAutomaticRefetch.json();
assert.equal(indexOnlyAutomaticBody.success, true);
assert.equal(indexOnlyAutomaticBody.diff_result.has_new_uninitialized, false);
const indexOnlyListResponse = await orderListRoute.GET(
  new Request("http://local.test/api/orders/list")
);
const indexOnlyListBody = await indexOnlyListResponse.json();
assert.equal(indexOnlyListBody.success, true);
assert.deepEqual(
  indexOnlyListBody.orders.map((order) => order.unique_key),
  [indexOnlyOrder.unique_key]
);
assert.equal(indexOnlyListBody.orders[0].needs_initialization, false);

prepared = await prepareAbsencesAndNewOrders({
  historicalCount: 1,
  newCount: 1,
  scenario: "SNAPSHOT-MISSING",
});
const snapshotMissingOrder = prepared.newOrders[0];
await initializeOrderData([snapshotMissingOrder]);
const snapshotMissingU1Raw = await redis.get(`order:${snapshotMissingOrder.unique_key}`);
const snapshotMissingU1 =
  typeof snapshotMissingU1Raw === "string"
    ? JSON.parse(snapshotMissingU1Raw)
    : snapshotMissingU1Raw;
await redis.set(
  `order:${snapshotMissingOrder.unique_key}`,
  JSON.stringify({ ...snapshotMissingU1, app_memo: "preserve-index-repair" })
);
await redis.del(`order_snapshot:${snapshotMissingOrder.unique_key}`);
const snapshotRepairDetailCalls = baseFake.getWorkflowDetailCallCount();
const snapshotRepairResponse = await withinGuard(
  post(initRoute, "/api/orders/init", {
    refetch_cycle_id: prepared.cycleId,
  }),
  "snapshot-missing-init-repair",
  2_000
);
const snapshotRepairBody = await snapshotRepairResponse.json();
assert.equal(snapshotRepairBody.success, true);
assert.equal(snapshotRepairBody.initialized, 1);
assert.equal(
  baseFake.getWorkflowDetailCallCount() - snapshotRepairDetailCalls,
  1
);
assert.ok(await redis.get(`order_snapshot:${snapshotMissingOrder.unique_key}`));
const repairedU1Raw = await redis.get(`order:${snapshotMissingOrder.unique_key}`);
const repairedU1 = typeof repairedU1Raw === "string" ? JSON.parse(repairedU1Raw) : repairedU1Raw;
assert.equal(repairedU1.app_memo, "preserve-index-repair");
assert.equal((await readRefetchState()).post_init_refetch_ready, true);

// The whole BASE phase is also finite. Details that each fit their own budget
// may cumulatively exhaust the phase; completed details are persisted and only
// the remaining count is exposed for a reload-based resume.
prepared = await prepareAbsencesAndNewOrders({
  historicalCount: 1,
  newCount: 5,
  scenario: "PHASE-BUDGET",
});
baseFake.setWorkflowDetailDelay(20);
AbortSignal.timeout = (timeoutMs) =>
  nativeAbortTimeoutForBudgets(
    timeoutMs === initRoute.INIT_BASE_PHASE_TIMEOUT_MS ? 55 : 100
  );
try {
  const phaseBudgetResponse = await withinGuard(
    post(initRoute, "/api/orders/init", {
      refetch_cycle_id: prepared.cycleId,
    }),
    "whole-init-base-phase-budget",
    500
  );
  const phaseBudgetBody = await phaseBudgetResponse.json();
  assert.equal(phaseBudgetBody.success, false);
  assert.equal(phaseBudgetBody.status, "partial_failed");
  assert.ok(phaseBudgetBody.initialized > 0);
  assert.ok(phaseBudgetBody.initialized < prepared.newOrders.length);
  const phaseBudgetState = await readRefetchState();
  assert.equal(
    phaseBudgetState.new_uninitialized_count,
    prepared.newOrders.length - phaseBudgetBody.initialized
  );
  assert.equal(phaseBudgetState.post_init_refetch_ready, false);
  assert.equal(await redis.get(WORKFLOW_LEASE_KEY), null);
} finally {
  AbortSignal.timeout = nativeAbortTimeoutForBudgets;
}

// RED: recover safely from a partially initialized same-bundle group. The
// retry must fetch only the missing order, preserve prior U1/U4/U2 values,
// complete U2 membership, and only then authorize automatic refetch.
prepared = await prepareAbsencesAndNewOrders({
  historicalCount: 2,
  newCount: 3,
  scenario: "PARTIAL-RESUME",
});
const [firstNew, failedNew, thirdNew] = prepared.newOrders;
baseFake.setWorkflowFetchFailures([failedNew.unique_key]);
const firstPartialResponse = await withinGuard(
  post(initRoute, "/api/orders/init", {
    refetch_cycle_id: prepared.cycleId,
  }),
  "first-partial-init",
  2_000
);
const firstPartialBody = await firstPartialResponse.json();
assert.equal(firstPartialBody.success, false);
assert.equal(firstPartialBody.status, "partial_failed");
assert.equal(firstPartialBody.initialized, 2);
assert.equal((await readRefetchState()).post_init_refetch_ready, false);
const reloadReviewResponse = await diffConfirmRoute.GET(
  new Request("http://local.test/api/orders/diff-confirm")
);
assert.equal(reloadReviewResponse.status, 200);
const reloadReviewBody = await reloadReviewResponse.json();
assert.equal(reloadReviewBody.success, true);
assert.equal(reloadReviewBody.review.refetch_cycle_id, prepared.cycleId);
assert.equal(reloadReviewBody.review.phase, "awaiting_initialization");
assert.equal(reloadReviewBody.review.new_uninitialized_count, 1);
assert.equal(reloadReviewBody.review.can_confirm, false);

const firstSnapshotRaw = await redis.get(`order_snapshot:${firstNew.unique_key}`);
const firstSnapshot =
  typeof firstSnapshotRaw === "string" ? JSON.parse(firstSnapshotRaw) : firstSnapshotRaw;
assert.ok(firstSnapshot?.bundle_group_id);
const bundleKey = `bundle:${firstSnapshot.bundle_group_id}`;
const firstU1Raw = await redis.get(`order:${firstNew.unique_key}`);
const firstU1 = typeof firstU1Raw === "string" ? JSON.parse(firstU1Raw) : firstU1Raw;
const firstU4Key = `picking:${firstNew.order_items[0].order_item_id}`;
const firstU4Raw = await redis.get(firstU4Key);
const firstU4 = typeof firstU4Raw === "string" ? JSON.parse(firstU4Raw) : firstU4Raw;
const bundleRaw = await redis.get(bundleKey);
const bundle = typeof bundleRaw === "string" ? JSON.parse(bundleRaw) : bundleRaw;
assert.ok(bundle.order_unique_keys.includes(firstNew.unique_key));
assert.ok(bundle.order_unique_keys.includes(thirdNew.unique_key));
assert.equal(bundle.order_unique_keys.includes(failedNew.unique_key), false);
const bundleMembersBeforeResume = [...bundle.order_unique_keys];

await redis.set(
  `order:${firstNew.unique_key}`,
  JSON.stringify({ ...firstU1, app_memo: "preserve-on-resume" })
);
await redis.set(
  firstU4Key,
  JSON.stringify({ ...firstU4, scanned_quantity: 1 })
);
await redis.set(bundleKey, JSON.stringify({ ...bundle, tracking_number: "PRESERVE" }));

baseFake.setWorkflowFetchFailures([]);
const detailCallsBeforeResume = baseFake.getWorkflowDetailCallCount();
const resumedInitResponse = await withinGuard(
  post(initRoute, "/api/orders/init", {
    refetch_cycle_id: prepared.cycleId,
  }),
  "resumed-partial-init",
  2_000
);
const resumedInitBody = await resumedInitResponse.json();
assert.equal(resumedInitBody.success, true);
assert.equal(resumedInitBody.status, "completed");
assert.equal(resumedInitBody.initialized, 1);
assert.equal(
  baseFake.getWorkflowDetailCallCount() - detailCallsBeforeResume,
  1,
  "resume must fetch only the uninitialized order"
);
const resumedState = await readRefetchState();
assert.equal(resumedState.post_init_refetch_ready, true);
assert.equal(resumedState.phase, "awaiting_initialization");

const preservedU1Raw = await redis.get(`order:${firstNew.unique_key}`);
const preservedU1 =
  typeof preservedU1Raw === "string" ? JSON.parse(preservedU1Raw) : preservedU1Raw;
assert.equal(preservedU1.app_memo, "preserve-on-resume");
const preservedU4Raw = await redis.get(firstU4Key);
const preservedU4 =
  typeof preservedU4Raw === "string" ? JSON.parse(preservedU4Raw) : preservedU4Raw;
assert.equal(preservedU4.scanned_quantity, 1);
const repairedBundleRaw = await redis.get(bundleKey);
const repairedBundle =
  typeof repairedBundleRaw === "string"
    ? JSON.parse(repairedBundleRaw)
    : repairedBundleRaw;
assert.equal(repairedBundle.tracking_number, "PRESERVE");
assert.deepEqual(
  [...repairedBundle.order_unique_keys].sort(),
  [...bundleMembersBeforeResume, failedNew.unique_key].sort()
);

const resumedAutomaticRefetch = await withinGuard(
  post(refetchRoute, "/api/orders/refetch", {
    source_refetch_cycle_id: prepared.cycleId,
  }),
  "resumed-automatic-refetch",
  2_000
);
const resumedAutomaticBody = await resumedAutomaticRefetch.json();
assert.equal(resumedAutomaticBody.success, true);
assert.equal(resumedAutomaticBody.diff_result.has_new_uninitialized, false);
assert.equal((await readRefetchState()).phase, "awaiting_review");
const resumedOrderListResponse = await orderListRoute.GET(
  new Request("http://local.test/api/orders/list")
);
assert.equal(resumedOrderListResponse.status, 200);
const resumedOrderListBody = await resumedOrderListResponse.json();
assert.equal(resumedOrderListBody.success, true);
assert.deepEqual(
  resumedOrderListBody.orders
    .map((order) => order.unique_key)
    .sort(),
  prepared.newOrders.map((order) => order.unique_key).sort()
);
assert.equal(
  resumedOrderListBody.orders.some((order) => order.needs_initialization),
  false
);
for (const order of prepared.newOrders) {
  assert.ok((await redis.smembers("index:orders")).includes(order.unique_key));
  assert.ok(await redis.get(`order:${order.unique_key}`));
  assert.ok(await redis.get(`order_snapshot:${order.unique_key}`));
  assert.ok(await redis.get(`picking:${order.order_items[0].order_item_id}`));
}

// Deterministic RED: one stalled BASE detail must not leave init pending until
// the platform limit. The route must return a structured failure promptly,
// keep the same recovery cycle, and must not authorize automatic refetch.
prepared = await prepareAbsencesAndNewOrders();
baseFake.setWorkflowDetailStalls([prepared.newOrders[0].unique_key]);
const nativeAbortTimeout = AbortSignal.timeout;
AbortSignal.timeout = () => nativeAbortTimeout(25);
try {
  const stalledResponse = await withinGuard(
    post(initRoute, "/api/orders/init", {
      refetch_cycle_id: prepared.cycleId,
    }),
    "init-detail-timeout"
  );
  const stalledBody = await stalledResponse.json();
  assert.equal(stalledBody.success, false);
  assert.equal(stalledBody.status, "partial_failed");
  assert.equal(stalledBody.failed_unique_keys.length, 1);
  assert.equal(typeof stalledBody.message, "string");

  const stalledState = await readRefetchState();
  assert.equal(stalledState.refetch_cycle_id, prepared.cycleId);
  assert.equal(stalledState.phase, "awaiting_initialization");
  assert.notEqual(stalledState.post_init_refetch_ready, true);
  assert.equal(await redis.get(WORKFLOW_LEASE_KEY), null);
} finally {
  AbortSignal.timeout = nativeAbortTimeout;
}

// If owner A loses the lease while a BASE detail is in flight, owner A must
// not initialize the order, mark post-init ready, or delete owner B's lease.
prepared = await prepareAbsencesAndNewOrders();
const detailGate = baseFake.installWorkflowDetailGate(
  prepared.newOrders[0].unique_key
);
const staleInitPromise = post(initRoute, "/api/orders/init", {
  refetch_cycle_id: prepared.cycleId,
});
await detailGate.entered;
await redis.del(WORKFLOW_LEASE_KEY);
const successorLease = await acquireWorkflowLease("refetch", "cycle-successor");
assert.ok(successorLease);
detailGate.release();

const staleInitResponse = await withinGuard(
  staleInitPromise,
  "init-stale-owner",
  1_000
);
assert.equal(staleInitResponse.status, 409);
assert.equal((await staleInitResponse.json()).success, false);
const staleState = await readRefetchState();
assert.equal(staleState.refetch_cycle_id, prepared.cycleId);
assert.notEqual(staleState.post_init_refetch_ready, true);
assert.equal(
  (await redis.smembers("index:orders")).includes(prepared.newOrders[0].unique_key),
  false
);
assert.equal(await redis.get(WORKFLOW_LEASE_KEY), successorLease.serialized);
assert.equal(await releaseWorkflowLease(successorLease), true);

// A stalled BASE order-list request is also bounded and cannot authorize the
// automatic refetch phase.
prepared = await prepareAbsencesAndNewOrders({ scenario: "LIST-STALL" });
baseFake.setWorkflowOrderListStall(true);
AbortSignal.timeout = () => nativeAbortTimeout(25);
try {
  const listTimeoutResponse = await withinGuard(
    post(initRoute, "/api/orders/init", {
      refetch_cycle_id: prepared.cycleId,
    }),
    "init-list-timeout"
  );
  assert.equal(listTimeoutResponse.status, 500);
  assert.equal((await listTimeoutResponse.json()).success, false);
  const listTimeoutState = await readRefetchState();
  assert.equal(listTimeoutState.refetch_cycle_id, prepared.cycleId);
  assert.equal(listTimeoutState.phase, "awaiting_initialization");
  assert.notEqual(listTimeoutState.post_init_refetch_ready, true);
  assert.equal(await redis.get(WORKFLOW_LEASE_KEY), null);
} finally {
  AbortSignal.timeout = nativeAbortTimeout;
}

// Prior Production verification shape: eight absences and five new orders.
prepared = await prepareAbsencesAndNewOrders({
  historicalCount: 8,
  newCount: 5,
  scenario: "PRIOR",
});
const priorInitResponse = await withinGuard(
  post(initRoute, "/api/orders/init", {
    refetch_cycle_id: prepared.cycleId,
  }),
  "prior-shape-init",
  2_000
);
assert.equal((await priorInitResponse.json()).success, true);
assert.equal(baseFake.getWorkflowDetailCallCount(), 5);
const priorAutomaticRefetch = await withinGuard(
  post(refetchRoute, "/api/orders/refetch", {
    source_refetch_cycle_id: prepared.cycleId,
  }),
  "prior-shape-automatic-refetch",
  2_000
);
const priorAutomaticBody = await priorAutomaticRefetch.json();
assert.equal(priorAutomaticBody.success, true);
assert.equal(priorAutomaticBody.diff_result.has_new_uninitialized, false);
assert.equal(priorAutomaticBody.diff_result.new_uninitialized_count, 0);
assert.equal((await readRefetchState()).phase, "awaiting_review");

console.log("init auto-refetch recovery tests passed");

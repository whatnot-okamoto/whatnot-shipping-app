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

import assert from "node:assert/strict";

process.env.APP_ENVIRONMENT = "local";
process.env.BASE_DATA_MODE = "mock";
process.env.APP_STORE_MODE = "memory";

const { FIXTURE_DATA } = await import("../lib/pdf-fixture-data.ts");
const { redis } = await import("../lib/upstash.ts");
const { initializeOrderData } = await import("../lib/order-store.ts");
const baseFake = await import("./fakes/workflow-base-api.ts");
const refetchRoute = await import("../app/api/orders/refetch/route.ts");
const diffRoute = await import("../app/api/orders/diff-confirm/route.ts");
const initRoute = await import("../app/api/orders/init/route.ts");
const sessionRoute = await import("../app/api/session/start/route.ts");
const leaseModule = await import("../lib/workflow-operation-lease.ts");

const {
  acquireWorkflowLease,
  fencedMutate,
  releaseWorkflowLease,
  WORKFLOW_LEASE_KEY,
  WORKFLOW_LEASE_TTL_SECONDS,
  WORKFLOW_LEASE_RENEW_INTERVAL_MS,
  DIFF_CONFIRM_CHUNK_SIZE,
} = leaseModule;

assert.equal(WORKFLOW_LEASE_TTL_SECONDS, 90);
assert.equal(WORKFLOW_LEASE_RENEW_INTERVAL_MS, 30_000);
assert.equal(DIFF_CONFIRM_CHUNK_SIZE, 100);

async function clearMemoryRedis() {
  const keys = await redis.keys("*");
  if (keys.length > 0) await redis.del(...keys);
}

function makeOrder(uniqueKey, itemId) {
  const order = structuredClone(FIXTURE_DATA["F-01"].order);
  order.unique_key = uniqueKey;
  order.dispatch_status = "ordered";
  order.order_items[0].order_item_id = itemId;
  order.order_items[0].item_id = itemId * 100;
  order.shipping_lines[0].shipping_method = "宅配便";
  order.shipping_lines[0].order_item_ids = [String(itemId)];
  return order;
}

async function readJson(key) {
  const raw = await redis.get(key);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

function stateFor(cycleId, overrides = {}) {
  return {
    refetch_done_flag: true,
    diff_confirmed_flag: false,
    refetched_at: new Date().toISOString(),
    has_new_uninitialized: false,
    refetch_cycle_id: cycleId,
    refetch_result: "complete",
    phase: "awaiting_review",
    new_uninitialized_count: 0,
    order_results: {},
    ...overrides,
  };
}

function post(route, path, body) {
  return route.POST(new Request(`http://local.test${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

function postDiff(cycleId) {
  return post(diffRoute, "/api/orders/diff-confirm", { refetch_cycle_id: cycleId });
}

async function assertOperationConflict(response) {
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error_code, "orders_operation_in_progress");
}

function installAtomicGate(methodName, predicate = () => true) {
  const original = redis[methodName];
  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  let used = false;
  redis[methodName] = async function (...args) {
    if (!used && predicate(...args)) {
      used = true;
      enteredResolve();
      await wait;
    }
    return original.apply(this, args);
  };
  return {
    entered,
    release,
    restore() { redis[methodName] = original; },
  };
}

// I: exact refetch rejection happens before state reset, pending deletion, or BASE.
await clearMemoryRedis();
baseFake.setWorkflowBaseOrders([]);
const rejectCycle = "cycle-reject";
const rejectState = stateFor(rejectCycle);
await redis.set("orders:refetch_state", JSON.stringify(rejectState));
await redis.set("order_snapshot_pending:keep", JSON.stringify({ keep: true }));
await redis.sadd("index:order_snapshot_pending", "keep");
const rejectedRefetch = await post(refetchRoute, "/api/orders/refetch");
assert.equal(rejectedRefetch.status, 409);
assert.deepEqual(await readJson("orders:refetch_state"), rejectState);
assert.deepEqual(await readJson("order_snapshot_pending:keep"), { keep: true });
assert.deepEqual(await redis.smembers("index:order_snapshot_pending"), ["keep"]);
assert.equal(baseFake.getWorkflowOrderListCallCount(), 0);

// init is closed to a genuine first bootstrap or the same-cycle
// awaiting_initialization recovery. Every other state stops before BASE and
// leaves business Redis data unchanged.
for (const phase of ["awaiting_review", "promoting", "postprocessing", "confirmed"]) {
  await clearMemoryRedis();
  baseFake.setWorkflowBaseOrders([]);
  const cycleId = `cycle-init-reject-${phase}`;
  const protectedState = stateFor(cycleId, {
    phase,
    diff_confirmed_flag: phase === "confirmed",
  });
  await redis.set("orders:refetch_state", JSON.stringify(protectedState));
  await redis.set("order:protected", JSON.stringify({ keep: phase }));
  const beforeKeys = (await redis.keys("*")).sort();
  const response = await post(initRoute, "/api/orders/init");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error_code, "init_not_allowed");
  assert.equal(baseFake.getWorkflowOrderListCallCount(), 0);
  assert.deepEqual((await redis.keys("*")).sort(), beforeKeys);
  assert.deepEqual(await readJson("orders:refetch_state"), protectedState);
  assert.deepEqual(await readJson("order:protected"), { keep: phase });
}

await clearMemoryRedis();
baseFake.setWorkflowBaseOrders([]);
const initRecoveryCycle = "cycle-init-recovery";
await redis.set(
  "orders:refetch_state",
  JSON.stringify(stateFor(initRecoveryCycle, {
    phase: "awaiting_initialization",
    has_new_uninitialized: true,
    new_uninitialized_count: 1,
  }))
);
const recoveryInit = await post(initRoute, "/api/orders/init", {
  refetch_cycle_id: initRecoveryCycle,
});
assert.equal(recoveryInit.status, 200);
assert.equal((await readJson("orders:refetch_state")).post_init_refetch_ready, true);

await clearMemoryRedis();
baseFake.setWorkflowBaseOrders([]);
await redis.set(
  "orders:refetch_state",
  JSON.stringify(stateFor("cycle-init-mismatch", {
    phase: "awaiting_initialization",
    has_new_uninitialized: true,
  }))
);
const mismatchState = await readJson("orders:refetch_state");
const mismatchInit = await post(initRoute, "/api/orders/init", {
  refetch_cycle_id: "different-cycle",
});
assert.equal(mismatchInit.status, 409);
assert.equal(baseFake.getWorkflowOrderListCallCount(), 0);
assert.deepEqual(await readJson("orders:refetch_state"), mismatchState);

await clearMemoryRedis();
baseFake.setWorkflowBaseOrders([]);
const bootstrapInit = await post(initRoute, "/api/orders/init");
assert.equal(bootstrapInit.status, 200);
assert.equal(baseFake.getWorkflowOrderListCallCount(), 1);

// G/H: while one diff-confirm owns the lease, a duplicate POST and a refetch
// from another tab are both rejected atomically.
await clearMemoryRedis();
baseFake.setWorkflowBaseOrders([]);
const concurrentDiffCycle = "cycle-concurrent-diff";
await redis.set("orders:refetch_state", JSON.stringify(stateFor(concurrentDiffCycle)));
const diffGate = installAtomicGate(
  "fencedMutate",
  (_leaseKey, _owner, mutations) =>
    mutations.some((mutation) =>
      mutation.type === "set" &&
      mutation.key === "orders:refetch_state" &&
      String(mutation.value).includes('"phase":"promoting"')
    )
);
const firstDiffPromise = postDiff(concurrentDiffCycle);
await diffGate.entered;
await assertOperationConflict(await postDiff(concurrentDiffCycle));
await assertOperationConflict(await post(refetchRoute, "/api/orders/refetch"));
diffGate.release();
assert.equal((await firstDiffPromise).status, 200);
diffGate.restore();

// M/N/O: after A expires and B owns the lease, every A write category,
// renewal, phase finalization, and release is rejected.
await clearMemoryRedis();
const ownerA = await acquireWorkflowLease("diff-confirm", "cycle-a");
assert.ok(ownerA);
await redis.del(WORKFLOW_LEASE_KEY);
const ownerB = await acquireWorkflowLease("refetch", "cycle-b");
assert.ok(ownerB);
await assert.rejects(
  fencedMutate(ownerA, [
    { type: "set", key: "order_snapshot:stale", value: "chunk" },
    { type: "set", key: "orders:refetch_state", value: "phase" },
    { type: "set_nx", key: "order:init-stale", value: "init" },
    { type: "del", keys: ["order_snapshot_pending:stale"] },
    { type: "sadd", key: "index:orders", members: ["stale"] },
    { type: "srem", key: "index:order_snapshot_pending", members: ["stale"] },
  ]),
  /no longer owned/
);
assert.equal(await redis.get("order_snapshot:stale"), null);
assert.equal(await redis.get("orders:refetch_state"), null);
assert.equal(await redis.compareAndExpire(WORKFLOW_LEASE_KEY, ownerA.serialized, 90), false);
assert.equal(await releaseWorkflowLease(ownerA), false);
assert.deepEqual(await readJson(WORKFLOW_LEASE_KEY), JSON.parse(ownerB.serialized));
assert.equal(await releaseWorkflowLease(ownerB), true);

// Q/R: init and refetch exclude each other in both directions.
await clearMemoryRedis();
baseFake.setWorkflowBaseOrders([]);
let baseGate = baseFake.installWorkflowOrderListGate();
const initPromise = post(initRoute, "/api/orders/init");
await baseGate.entered;
await assertOperationConflict(await post(refetchRoute, "/api/orders/refetch"));
baseGate.release();
assert.equal((await initPromise).status, 200);

await clearMemoryRedis();
baseFake.setWorkflowBaseOrders([]);
baseGate = baseFake.installWorkflowOrderListGate();
const refetchPromise = post(refetchRoute, "/api/orders/refetch");
await baseGate.entered;
await assertOperationConflict(await post(initRoute, "/api/orders/init"));
baseGate.release();
assert.equal((await refetchPromise).status, 200);

// S/T: init and diff-confirm exclude each other in both directions.
await clearMemoryRedis();
baseFake.setWorkflowBaseOrders([]);
const initDiffCycle = "cycle-init-diff";
baseGate = baseFake.installWorkflowOrderListGate();
const initAgainstDiff = post(initRoute, "/api/orders/init");
await baseGate.entered;
await assertOperationConflict(await postDiff(initDiffCycle));
baseGate.release();
await initAgainstDiff;

await clearMemoryRedis();
baseFake.setWorkflowBaseOrders([]);
const diffInitCycle = "cycle-diff-init";
await redis.set("orders:refetch_state", JSON.stringify(stateFor(diffInitCycle)));
const diffInitGate = installAtomicGate(
  "fencedMutate",
  (_leaseKey, _owner, mutations) =>
    mutations.some((mutation) =>
      mutation.type === "set" && String(mutation.value).includes('"phase":"promoting"')
    )
);
const diffAgainstInit = postDiff(diffInitCycle);
await diffInitGate.entered;
await assertOperationConflict(await post(initRoute, "/api/orders/init"));
diffInitGate.release();
assert.equal((await diffAgainstInit).status, 200);
diffInitGate.restore();

async function prepareSessionReady(uniqueKey, itemId) {
  await clearMemoryRedis();
  const order = makeOrder(uniqueKey, itemId);
  await initializeOrderData([order]);
  baseFake.setWorkflowBaseOrders([order]);
  const cycleId = `cycle-${uniqueKey}`;
  const snapshot = await readJson(`order_snapshot:${uniqueKey}`);
  await redis.set(
    `order_snapshot:${uniqueKey}`,
    JSON.stringify({
      ...snapshot,
      pdf_verification_cycle_id: cycleId,
      open_order_presence: "present",
      pdf_generation_outcome: "eligible",
      pdf_issue_codes: [],
    })
  );
  await redis.set(
    "orders:refetch_state",
    JSON.stringify(stateFor(cycleId, {
      phase: "confirmed",
      diff_confirmed_flag: true,
      order_results: {
        [uniqueKey]: { status: "verified_eligible", issues: [] },
      },
    }))
  );
  return { order, cycleId };
}

// session:current NX failure: no candidate session body and no refetch delete.
let prepared = await prepareSessionReady("TEST-SESSION-NX", 30_001);
await redis.set("session:current", "existing-session");
await redis.set("session:existing-session", JSON.stringify({ keep: true }));
const beforeSessionKeys = (await redis.keys("session:*")).sort();
const beforeRefetch = await readJson("orders:refetch_state");
const sessionConflict = await post(sessionRoute, "/api/session/start", {
  selected_unique_keys: [prepared.order.unique_key],
  refetch_cycle_id: prepared.cycleId,
});
assert.equal(sessionConflict.status, 409);
assert.deepEqual((await redis.keys("session:*")).sort(), beforeSessionKeys);
assert.deepEqual(await readJson("orders:refetch_state"), beforeRefetch);

// U/V: session start and refetch exclude each other in both directions.
prepared = await prepareSessionReady("TEST-SESSION-FIRST", 30_002);
const sessionGate = installAtomicGate("fencedStartSession");
const sessionPromise = post(sessionRoute, "/api/session/start", {
  selected_unique_keys: [prepared.order.unique_key],
  refetch_cycle_id: prepared.cycleId,
});
await sessionGate.entered;
await assertOperationConflict(await post(refetchRoute, "/api/orders/refetch"));
sessionGate.release();
assert.equal((await sessionPromise).status, 200);
sessionGate.restore();

prepared = await prepareSessionReady("TEST-REFETCH-FIRST", 30_003);
baseGate = baseFake.installWorkflowOrderListGate();
const refetchAgainstSession = post(refetchRoute, "/api/orders/refetch");
await baseGate.entered;
const sessionAgainstRefetch = await post(sessionRoute, "/api/session/start", {
  selected_unique_keys: [prepared.order.unique_key],
  refetch_cycle_id: prepared.cycleId,
});
await assertOperationConflict(sessionAgainstRefetch);
baseGate.release();
assert.equal((await refetchAgainstSession).status, 200);

console.log("workflow operation fencing tests passed");

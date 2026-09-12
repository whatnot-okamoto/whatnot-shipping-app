import assert from "node:assert/strict";

process.env.APP_ENVIRONMENT = "local";
process.env.BASE_DATA_MODE = "mock";
process.env.APP_STORE_MODE = "memory";

const { FIXTURE_DATA } = await import("../lib/pdf-fixture-data.ts");
const { redis } = await import("../lib/upstash.ts");
const { initializeOrderData } = await import("../lib/order-store.ts");
const baseFake = await import("./fakes/workflow-base-api.ts");
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
  order.order_items[0].order_item_id = itemId;
  order.order_items[0].item_id = itemId * 100;
  order.shipping_lines[0].order_item_ids = [String(itemId)];
  return order;
}

function installRoundTripDelay(delayMs) {
  const directMethodNames = ["get", "set", "del", "sadd", "srem", "smembers"];
  const originals = new Map();
  let batchExecuting = false;

  const delay = () => new Promise((resolve) => setTimeout(resolve, delayMs));

  for (const name of directMethodNames) {
    const original = redis[name].bind(redis);
    originals.set(name, redis[name]);
    redis[name] = async (...args) => {
      if (!batchExecuting) await delay();
      return original(...args);
    };
  }

  for (const name of [
    "compareAndDelete",
    "compareAndExpire",
    "fencedMutate",
    "fencedStartSession",
  ]) {
    const original = redis[name].bind(redis);
    originals.set(name, redis[name]);
    redis[name] = async (...args) => {
      await delay();
      batchExecuting = true;
      try {
        return await original(...args);
      } finally {
        batchExecuting = false;
      }
    };
  }

  const originalPipeline = redis.pipeline.bind(redis);
  originals.set("pipeline", redis.pipeline);
  redis.pipeline = () => {
    const pipeline = originalPipeline();
    const originalExec = pipeline.exec.bind(pipeline);
    pipeline.exec = async (...args) => {
      await delay();
      batchExecuting = true;
      try {
        return await originalExec(...args);
      } finally {
        batchExecuting = false;
      }
    };
    return pipeline;
  };

  return () => {
    for (const [name, original] of originals) redis[name] = original;
  };
}

await clearMemoryRedis();
const disappearedOrders = Array.from({ length: 100 }, (_, index) =>
  makeOrder(`TEST-DIFF-CONFIRM-${index + 1}`, 10_000 + index)
);
await initializeOrderData(disappearedOrders);
baseFake.setWorkflowBaseOrders([]);

const refetchResponse = await refetchRoute.POST(
  new Request("http://local.test/api/orders/refetch", { method: "POST" })
);
assert.equal(refetchResponse.status, 200);

const rawState = await redis.get("orders:refetch_state");
const state = typeof rawState === "string" ? JSON.parse(rawState) : rawState;
assert.ok(state?.refetch_cycle_id);

const restoreDelay = installRoundTripDelay(5);
try {
  const startedAt = performance.now();
  const response = await diffConfirmRoute.POST(
    new Request("http://local.test/api/orders/diff-confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refetch_cycle_id: state.refetch_cycle_id }),
    })
  );
  const elapsedMs = performance.now() - startedAt;

  assert.equal(response.status, 200);
  assert.ok(
    elapsedMs < 500,
    `diff-confirm route took ${elapsedMs.toFixed(1)}ms for 100 pending snapshots`
  );
} finally {
  restoreDelay();
}

async function readState() {
  const raw = await redis.get("orders:refetch_state");
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function postDiff(cycleId) {
  return diffConfirmRoute.POST(
    new Request("http://local.test/api/orders/diff-confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refetch_cycle_id: cycleId }),
    })
  );
}

function cycleState(cycleId, overrides = {}) {
  return {
    refetch_done_flag: true,
    diff_confirmed_flag: false,
    refetched_at: new Date().toISOString(),
    has_new_uninitialized: false,
    refetch_cycle_id: cycleId,
    refetch_result: "complete",
    order_results: {},
    ...overrides,
  };
}

// B/C: legacy partial processing and pending-body loss with a current-cycle
// snapshot are resumable; the stale index member is removed safely.
await clearMemoryRedis();
const partialOrders = [
  makeOrder("TEST-PARTIAL-DONE", 20_001),
  makeOrder("TEST-PARTIAL-REMAINING", 20_002),
];
await initializeOrderData(partialOrders);
const partialCycle = "cycle-partial";
for (const order of partialOrders) {
  const raw = await redis.get(`order_snapshot:${order.unique_key}`);
  const snapshot = typeof raw === "string" ? JSON.parse(raw) : raw;
  const pending = {
    ...snapshot,
    pdf_verification_cycle_id: partialCycle,
    items_summary: `${snapshot.items_summary}-updated`,
  };
  await redis.sadd("index:order_snapshot_pending", order.unique_key);
  if (order.unique_key.endsWith("DONE")) {
    await redis.set(`order_snapshot:${order.unique_key}`, JSON.stringify(pending));
  } else {
    await redis.set(
      `order_snapshot_pending:${order.unique_key}`,
      JSON.stringify(pending)
    );
  }
}
await redis.set("orders:refetch_state", JSON.stringify(cycleState(partialCycle)));
assert.equal((await postDiff(partialCycle)).status, 200);
assert.deepEqual(await redis.smembers("index:order_snapshot_pending"), []);
assert.equal((await readState()).phase, "confirmed");

// D: body-less index orphan with old/unknown snapshot is not mutated.
await clearMemoryRedis();
const unsafeOrder = makeOrder("TEST-UNSAFE-ORPHAN", 20_003);
await initializeOrderData([unsafeOrder]);
const unsafeCycle = "cycle-unsafe";
await redis.sadd("index:order_snapshot_pending", unsafeOrder.unique_key);
const unsafeState = cycleState(unsafeCycle);
await redis.set("orders:refetch_state", JSON.stringify(unsafeState));
const unsafeResponse = await postDiff(unsafeCycle);
assert.equal(unsafeResponse.status, 409);
assert.deepEqual(await redis.smembers("index:order_snapshot_pending"), [unsafeOrder.unique_key]);
assert.deepEqual(await readState(), unsafeState);

// E: a lost HTTP response is safe to retry only after every completion
// condition (phase, flag, empty pending index) is true.
await clearMemoryRedis();
const retryCycle = "cycle-retry";
await redis.set("orders:refetch_state", JSON.stringify(cycleState(retryCycle)));
assert.equal((await postDiff(retryCycle)).status, 200);
const retryResponse = await postDiff(retryCycle);
assert.equal(retryResponse.status, 200);
assert.equal((await retryResponse.json()).already_complete, true);

// F: postprocessing failure leaves phase=postprocessing and flag=false; a
// second POST reruns PDF/CSV reset and atomically finalizes phase+flag.
await clearMemoryRedis();
const postprocessCycle = "cycle-postprocess";
await redis.set("orders:refetch_state", JSON.stringify(cycleState(postprocessCycle)));
await redis.set("session:current", "active-postprocess");
await redis.set(
  "session:active-postprocess",
  JSON.stringify({
    session_id: "active-postprocess",
    session_status: "active",
    locked_bundle_group_ids: [],
    refetch_done_flag: true,
    diff_confirmed_flag: false,
    checklist_printed_flag: false,
    pdf_output_done_flag: true,
    csv_status: { nekopos: "done", sagawa: "done", yamato: "done" },
    emergency_unlock_log: [],
  })
);
const originalFencedMutate = redis.fencedMutate;
let failPostprocessingOnce = true;
redis.fencedMutate = async function (...args) {
  const mutations = args[2];
  if (
    failPostprocessingOnce &&
    mutations.some((mutation) => mutation.type === "set" && mutation.key === "session:active-postprocess")
  ) {
    failPostprocessingOnce = false;
    throw new Error("simulated postprocessing failure");
  }
  return originalFencedMutate.apply(this, args);
};
try {
  assert.equal((await postDiff(postprocessCycle)).status, 500);
  assert.equal((await readState()).phase, "postprocessing");
  assert.equal((await readState()).diff_confirmed_flag, false);
  assert.equal((await postDiff(postprocessCycle)).status, 200);
  assert.equal((await readState()).phase, "confirmed");
  assert.equal((await readState()).diff_confirmed_flag, true);
  const rawSession = await redis.get("session:active-postprocess");
  const session = typeof rawSession === "string" ? JSON.parse(rawSession) : rawSession;
  assert.equal(session.pdf_output_done_flag, false);
  assert.deepEqual(session.csv_status, {
    nekopos: "pending",
    sagawa: "pending",
    yamato: "pending",
  });
} finally {
  redis.fencedMutate = originalFencedMutate;
}

// J/K: GET performs no BASE call/write, advertises the recovery limit, and
// provides exact/new legacy-compatible uninitialized counts.
await clearMemoryRedis();
const getCycle = "cycle-get";
await redis.set(
  "orders:refetch_state",
  JSON.stringify(cycleState(getCycle, { has_new_uninitialized: true }))
);
const beforeGet = JSON.stringify(await readState());
const getResponse = await diffConfirmRoute.GET(
  new Request("http://local.test/api/orders/diff-confirm")
);
const getBody = await getResponse.json();
assert.equal(getResponse.status, 200);
assert.equal(getBody.review.details_recovery, "remaining_only");
assert.match(getBody.review.message, /完全復元できません/);
assert.equal(getBody.review.new_uninitialized_count, null);
assert.equal(JSON.stringify(await readState()), beforeGet);
await redis.set(
  "orders:refetch_state",
  JSON.stringify(cycleState(getCycle, {
    has_new_uninitialized: true,
    new_uninitialized_count: 8,
  }))
);
const countedBody = await (
  await diffConfirmRoute.GET(new Request("http://local.test/api/orders/diff-confirm"))
).json();
assert.equal(countedBody.review.new_uninitialized_count, 8);

console.log("diff-confirm recovery tests passed");

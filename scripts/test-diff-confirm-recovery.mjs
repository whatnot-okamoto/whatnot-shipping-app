import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.env.APP_ENVIRONMENT = "local";
process.env.BASE_DATA_MODE = "mock";
process.env.APP_STORE_MODE = "memory";

const { FIXTURE_DATA } = await import("../lib/pdf-fixture-data.ts");
const { redis } = await import("../lib/upstash.ts");
const { initializeOrderData } = await import("../lib/order-store.ts");
const baseFake = await import("./fakes/workflow-base-api.ts");
const refetchRoute = await import("../app/api/orders/refetch/route.ts");
const diffConfirmRoute = await import("../app/api/orders/diff-confirm/route.ts");
const { getInitializationActionView, shouldShowDiffConfirmAction } = await import(
  "../app/orders/components/diff-confirm-view-policy.ts"
);
const { default: DiffAbsenceSummary } = await import(
  "../app/orders/components/DiffAbsenceSummary.ts"
);

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
const refetchBody = await refetchResponse.json();
assert.equal(refetchBody.diff_result.first_absence_count, 100);
assert.equal(refetchBody.diff_result.cycle_not_in_open_orders_count, 100);

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

async function readRedisContents() {
  const keys = (await redis.keys("*")).sort();
  return Promise.all(
    keys.map(async (key) => [
      key,
      key.startsWith("index:")
        ? (await redis.smembers(key)).sort()
        : await redis.get(key),
    ])
  );
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

// J fresh: all current-cycle pending details are available, fetch_failed
// warnings are reconstructed from order_results, and the full cycle absence
// total is returned without BASE or writes.
await clearMemoryRedis();
const getCycle = "cycle-get";
const freshOrder = makeOrder("TEST-GET-FRESH", 20_004);
await initializeOrderData([freshOrder]);
const freshSnapshotRaw = await redis.get(`order_snapshot:${freshOrder.unique_key}`);
const freshSnapshot =
  typeof freshSnapshotRaw === "string"
    ? JSON.parse(freshSnapshotRaw)
    : freshSnapshotRaw;
await redis.set(
  `order_snapshot_pending:${freshOrder.unique_key}`,
  JSON.stringify({
    ...freshSnapshot,
    pdf_verification_cycle_id: getCycle,
    items_summary: "changed in current cycle",
  })
);
await redis.sadd("index:order_snapshot_pending", freshOrder.unique_key);
await redis.set(
  "orders:refetch_state",
  JSON.stringify(cycleState(getCycle, {
    order_results: {
      "ABSENT-1": { status: "not_in_open_orders", issues: ["not_in_open_orders"] },
      "ABSENT-2": { status: "not_in_open_orders", issues: ["not_in_open_orders"] },
      "FETCH-FAILED": { status: "fetch_failed", issues: [] },
    },
  }))
);
const beforeGet = JSON.stringify(await readState());
const getResponse = await diffConfirmRoute.GET(
  new Request("http://local.test/api/orders/diff-confirm")
);
const getBody = await getResponse.json();
assert.equal(getResponse.status, 200);
assert.equal(getBody.review.review_status, "fresh");
assert.equal(getBody.review.can_confirm, true);
assert.equal(getBody.review.processed_details_fully_recoverable, true);
assert.equal(getBody.review.details_recovery, "full");
assert.equal(getBody.review.cycle_not_in_open_orders_count, 2);
assert.equal(getBody.review.has_fetch_failures, true);
assert.deepEqual(getBody.review.failed_unique_keys, ["FETCH-FAILED"]);
assert.ok(
  getBody.review.remaining_diff_summary.some(
    (item) => item.unique_key === "FETCH-FAILED" && item.severity === "warning"
  )
);
assert.equal(JSON.stringify(await readState()), beforeGet);

// J resuming_partial: reproduce the legacy route's normal partial completion.
// The processed order has already disappeared from both pending storage and
// its index, while only the unprocessed order remains indexed.
await clearMemoryRedis();
baseFake.setWorkflowBaseOrders([]);
const processedOrder = makeOrder("TEST-GET-PROCESSED", 20_005);
const remainingOrder = makeOrder("TEST-GET-REMAINING", 20_006);
await initializeOrderData([processedOrder, remainingOrder]);
const legacyPartialCycle = "cycle-get-legacy-partial";
for (const order of [processedOrder, remainingOrder]) {
  const rawSnapshot = await redis.get(`order_snapshot:${order.unique_key}`);
  const snapshot =
    typeof rawSnapshot === "string" ? JSON.parse(rawSnapshot) : rawSnapshot;
  await redis.set(
    `order_snapshot_pending:${order.unique_key}`,
    JSON.stringify({
      ...snapshot,
      pdf_verification_cycle_id: legacyPartialCycle,
      items_summary: `changed-${order.unique_key}`,
    })
  );
  await redis.sadd("index:order_snapshot_pending", order.unique_key);
}
const processedSnapshotRaw = await redis.get(
  `order_snapshot:${processedOrder.unique_key}`
);
const processedSnapshot =
  typeof processedSnapshotRaw === "string"
    ? JSON.parse(processedSnapshotRaw)
    : processedSnapshotRaw;
await redis.set(
  `order_snapshot:${processedOrder.unique_key}`,
  JSON.stringify({
    ...processedSnapshot,
    pdf_verification_cycle_id: legacyPartialCycle,
    items_summary: `changed-${processedOrder.unique_key}`,
  })
);
await redis.del(`order_snapshot_pending:${processedOrder.unique_key}`);
await redis.srem("index:order_snapshot_pending", processedOrder.unique_key);
await redis.set(
  "orders:refetch_state",
  JSON.stringify(
    cycleState(legacyPartialCycle, {
      order_results: {
        [processedOrder.unique_key]: {
          status: "verified_eligible",
          issues: [],
        },
        [remainingOrder.unique_key]: {
          status: "verified_eligible",
          issues: [],
        },
      },
    })
  )
);
const beforePartialGet = await readRedisContents();
const partialGetBody = await (
  await diffConfirmRoute.GET(new Request("http://local.test/api/orders/diff-confirm"))
).json();
assert.equal(partialGetBody.review.review_status, "resuming_partial");
assert.equal(partialGetBody.review.can_confirm, true);
assert.equal(partialGetBody.review.processed_details_fully_recoverable, false);
assert.equal(partialGetBody.review.details_recovery, "remaining_only");
assert.deepEqual(
  partialGetBody.review.remaining_diff_summary.map((item) => item.unique_key),
  [remainingOrder.unique_key]
);
assert.equal(baseFake.getWorkflowOrderListCallCount(), 0);
assert.deepEqual(await readRedisContents(), beforePartialGet);

// J conflict: an old-cycle/unknown orphan cannot be auto-recovered and the UI
// must not render an ordinary confirmation button.
await redis.set(
  `order_snapshot:${processedOrder.unique_key}`,
  JSON.stringify({ ...processedSnapshot, pdf_verification_cycle_id: "old-cycle" })
);
const conflictGetBody = await (
  await diffConfirmRoute.GET(new Request("http://local.test/api/orders/diff-confirm"))
).json();
assert.equal(conflictGetBody.review.review_status, "conflict");
assert.equal(conflictGetBody.review.can_confirm, false);
assert.equal(conflictGetBody.review.can_initialize, false);
assert.equal(conflictGetBody.review.processed_details_fully_recoverable, false);
assert.equal(conflictGetBody.review.details_recovery, "none");
assert.equal(
  shouldShowDiffConfirmAction({
    can_confirm: conflictGetBody.review.can_confirm,
    recovery_status: conflictGetBody.review.review_status,
  }),
  false
);
assert.equal(
  getInitializationActionView({
    has_new_uninitialized: true,
    can_initialize: conflictGetBody.review.can_initialize,
    recovery_status: conflictGetBody.review.review_status,
    requires_reload: false,
  }).visible,
  false,
  "conflict must not expose initialization even when stale state reports an uninitialized order"
);

// J confirmed: a fully completed cycle is not a recovery conflict and does
// not offer the ordinary confirmation action again.
await clearMemoryRedis();
const completedOrder = makeOrder("TEST-GET-CONFIRMED", 20_007);
await initializeOrderData([completedOrder]);
const completedCycle = "cycle-get-confirmed";
const completedSnapshotRaw = await redis.get(
  `order_snapshot:${completedOrder.unique_key}`
);
const completedSnapshot =
  typeof completedSnapshotRaw === "string"
    ? JSON.parse(completedSnapshotRaw)
    : completedSnapshotRaw;
await redis.set(
  `order_snapshot:${completedOrder.unique_key}`,
  JSON.stringify({
    ...completedSnapshot,
    pdf_verification_cycle_id: completedCycle,
  })
);
await redis.set(
  "orders:refetch_state",
  JSON.stringify(
    cycleState(completedCycle, {
      phase: "confirmed",
      diff_confirmed_flag: true,
      order_results: {
        [completedOrder.unique_key]: {
          status: "verified_eligible",
          issues: [],
        },
      },
    })
  )
);
const completedGetBody = await (
  await diffConfirmRoute.GET(new Request("http://local.test/api/orders/diff-confirm"))
).json();
assert.equal(completedGetBody.review.review_status, "confirmed");
assert.equal(completedGetBody.review.can_confirm, false);
assert.equal(completedGetBody.review.processed_details_fully_recoverable, false);
assert.equal(completedGetBody.review.details_recovery, "none");
assert.equal(
  shouldShowDiffConfirmAction({
    can_confirm: completedGetBody.review.can_confirm,
    recovery_status: completedGetBody.review.review_status,
  }),
  false
);

// UI fresh: continuing absences alone are not shown again.
const continuingAbsenceHtml = renderToStaticMarkup(
  createElement(DiffAbsenceSummary, {
    firstAbsenceCount: 0,
    cycleNotInOpenOrdersCount: 7,
  })
);
assert.equal(continuingAbsenceHtml, "");

// UI fresh: only the first-absence count is shown when a new absence exists.
const freshAbsenceHtml = renderToStaticMarkup(
  createElement(DiffAbsenceSummary, {
    firstAbsenceCount: 3,
    cycleNotInOpenOrdersCount: 7,
    recoveryStatus: "fresh",
  })
);
assert.match(freshAbsenceHtml, /今回初めて不在となった注文：3件/);
assert.doesNotMatch(freshAbsenceHtml, /今回cycleで不在判定となった総数/);

// UI recovery: a partial legacy-route recovery shows the full cycle total,
// not the first-absence count as though it were newly detected.
const recoveryAbsenceHtml = renderToStaticMarkup(
  createElement(DiffAbsenceSummary, {
    firstAbsenceCount: 3,
    cycleNotInOpenOrdersCount: 7,
    recoveryStatus: "resuming_partial",
  })
);
assert.match(recoveryAbsenceHtml, /今回cycleで不在判定となった総数：7件/);
assert.doesNotMatch(recoveryAbsenceHtml, /今回初めて不在となった注文/);

// K: new states provide the exact count; legacy states use null/count-less UI.
await redis.del(`order_snapshot_pending:${remainingOrder.unique_key}`);
await redis.del("index:order_snapshot_pending");
await redis.set(
  "orders:refetch_state",
  JSON.stringify(cycleState(getCycle, { has_new_uninitialized: true }))
);
const legacyCountBody = await (
  await diffConfirmRoute.GET(new Request("http://local.test/api/orders/diff-confirm"))
).json();
assert.equal(legacyCountBody.review.new_uninitialized_count, null);
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
assert.equal(countedBody.review.review_status, "fresh");
assert.equal(countedBody.review.phase, "legacy");
assert.equal(
  countedBody.review.can_initialize,
  false,
  "legacy state must not be upgraded to a safe initialization state"
);

await redis.set(
  "orders:refetch_state",
  JSON.stringify(cycleState(getCycle, {
    phase: "awaiting_initialization",
    has_new_uninitialized: true,
    new_uninitialized_count: 8,
  }))
);
const safeInitializationBody = await (
  await diffConfirmRoute.GET(new Request("http://local.test/api/orders/diff-confirm"))
).json();
assert.equal(safeInitializationBody.review.review_status, "fresh");
assert.equal(safeInitializationBody.review.can_confirm, false);
assert.equal(safeInitializationBody.review.can_initialize, true);
assert.equal(
  getInitializationActionView({
    has_new_uninitialized: true,
    can_initialize: safeInitializationBody.review.can_initialize,
    recovery_status: safeInitializationBody.review.review_status,
    requires_reload: false,
  }).visible,
  true
);

for (const unsafeInput of [
  {
    has_new_uninitialized: true,
    recovery_status: "fresh",
  },
  {
    has_new_uninitialized: true,
    can_initialize: "true",
    recovery_status: "fresh",
  },
  {
    has_new_uninitialized: true,
    can_initialize: true,
    recovery_status: "unexpected",
  },
]) {
  assert.equal(
    getInitializationActionView(unsafeInput).visible,
    false,
    "missing, malformed, or unknown initialization authority must fail closed"
  );
}

console.log("diff-confirm recovery tests passed");

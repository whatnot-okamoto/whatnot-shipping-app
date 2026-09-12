import assert from "node:assert/strict";

process.env.APP_ENVIRONMENT = "local";
process.env.BASE_DATA_MODE = "mock";
process.env.APP_STORE_MODE = "memory";

const nativeAbortTimeout = AbortSignal.timeout;
AbortSignal.timeout = () => nativeAbortTimeout(25);

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

async function postRefetchWithinGuard(scenario, timeoutMs = 250) {
  let guardTimer;
  try {
    return await Promise.race([
      refetchRoute.POST(
        new Request("http://local.test/api/orders/refetch", { method: "POST" })
      ),
      new Promise((_, reject) => {
        guardTimer = setTimeout(
          () => reject(new Error(`refetch route exceeded guard: ${scenario}`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (guardTimer) clearTimeout(guardTimer);
  }
}

await clearMemoryRedis();

baseFake.setWorkflowBaseOrders([]);
baseFake.setWorkflowOrderListStall(true);

try {
  const response = await postRefetchWithinGuard("order-list-timeout");

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    success: false,
    error_type: "retryable_error",
    error_code: "base_orders_fetch_failed",
    error: "BASE注文一覧を取得できませんでした。注文一覧を維持したまま再試行してください。",
  });
  const rawState = await redis.get("orders:refetch_state");
  const state = typeof rawState === "string" ? JSON.parse(rawState) : rawState;
  assert.equal(state.refetch_done_flag, false);
  assert.equal(state.diff_confirmed_flag, false);

  await clearMemoryRedis();
  const normalOrder = makeOrder("TEST-TIMEOUT-NORMAL", 501);
  const stalledOrder = makeOrder("TEST-TIMEOUT-STALLED", 502);
  await initializeOrderData([normalOrder, stalledOrder]);
  baseFake.setWorkflowBaseOrders([normalOrder, stalledOrder]);
  baseFake.setWorkflowDetailStalls([stalledOrder.unique_key]);

  const partialResponse = await postRefetchWithinGuard("detail-timeout");
  assert.equal(partialResponse.status, 200);
  const partialBody = await partialResponse.json();
  assert.equal(partialBody.diff_result.has_fetch_failures, true);
  assert.deepEqual(partialBody.diff_result.failed_unique_keys, [stalledOrder.unique_key]);

  const rawPartialState = await redis.get("orders:refetch_state");
  const partialState =
    typeof rawPartialState === "string" ? JSON.parse(rawPartialState) : rawPartialState;
  assert.equal(partialState.refetch_result, "partial");
  assert.equal(
    partialState.order_results[normalOrder.unique_key].status,
    "verified_eligible"
  );
  assert.equal(
    partialState.order_results[stalledOrder.unique_key].status,
    "fetch_failed"
  );

  await clearMemoryRedis();
  const disappearedOrders = Array.from({ length: 20 }, (_, index) =>
    makeOrder(`TEST-DISAPPEARED-${index + 1}`, 600 + index)
  );
  await initializeOrderData(disappearedOrders);
  baseFake.setWorkflowBaseOrders([]);

  const nativeRedisGet = redis.get.bind(redis);
  const nativeRedisPipeline = redis.pipeline.bind(redis);
  let snapshotGetCount = 0;
  let pipelineExecCount = 0;
  let pipelineExecuting = false;
  redis.get = async (key) => {
    if (String(key).startsWith("order_snapshot:") && !pipelineExecuting) {
      snapshotGetCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return nativeRedisGet(key);
  };
  redis.pipeline = () => {
    const pipeline = nativeRedisPipeline();
    const nativeExec = pipeline.exec.bind(pipeline);
    pipeline.exec = async () => {
      pipelineExecCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      pipelineExecuting = true;
      try {
        return await nativeExec();
      } finally {
        pipelineExecuting = false;
      }
    };
    return pipeline;
  };

  try {
    const disappearedResponse = await postRefetchWithinGuard(
      "disappeared-batch",
      2_000
    );
    assert.equal(disappearedResponse.status, 200);
    const disappearedBody = await disappearedResponse.json();
    assert.equal(disappearedBody.diff_result.diff_summary.length, 0);
    assert.equal(disappearedBody.diff_result.first_absence_count, 20);
    assert.equal(disappearedBody.diff_result.has_fetch_failures, false);
    assert.equal(snapshotGetCount, 0);
    assert.ok(
      pipelineExecCount <= 3,
      `disappeared snapshots used ${pipelineExecCount} pipeline round trips`
    );

    const rawState = await redis.get("orders:refetch_state");
    const state = typeof rawState === "string" ? JSON.parse(rawState) : rawState;
    const confirmResponse = await diffConfirmRoute.POST(
      new Request("http://local.test/api/orders/diff-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refetch_cycle_id: state.refetch_cycle_id }),
      })
    );
    assert.equal(confirmResponse.status, 200);
    snapshotGetCount = 0;
    pipelineExecCount = 0;
    const repeatedResponse = await postRefetchWithinGuard(
      "repeated-disappeared-batch",
      2_000
    );
    assert.equal(repeatedResponse.status, 200);
    const repeatedBody = await repeatedResponse.json();
    assert.equal(repeatedBody.diff_result.has_diff, false);
    assert.deepEqual(repeatedBody.diff_result.diff_summary, []);
    assert.equal(snapshotGetCount, 0);
    assert.ok(
      pipelineExecCount <= 6,
      `repeated disappeared snapshots used ${pipelineExecCount} pipeline round trips`
    );
  } finally {
    redis.get = nativeRedisGet;
    redis.pipeline = nativeRedisPipeline;
  }
} finally {
  AbortSignal.timeout = nativeAbortTimeout;
}

console.log("refetch timeout recovery tests passed");

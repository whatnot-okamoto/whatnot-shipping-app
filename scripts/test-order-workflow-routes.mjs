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
const sessionStartRoute = await import("../app/api/session/start/route.ts");
const {
  default: SessionStartRecoveryPanel,
  buildSessionStartFailure,
} = await import("../app/orders/components/SessionStartRecoveryPanel.ts");

async function clearMemoryRedis() {
  const keys = await redis.keys("*");
  if (keys.length > 0) await redis.del(...keys);
}

function makeOrder(uniqueKey, address, itemId) {
  const order = structuredClone(FIXTURE_DATA["F-01"].order);
  order.unique_key = uniqueKey;
  order.dispatch_status = "ordered";
  order.address = address;
  order.order_items[0].order_item_id = itemId;
  order.order_items[0].item_id = itemId * 100;
  order.shipping_lines[0].shipping_method = "宅配便";
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

await clearMemoryRedis();
const normalOrder = makeOrder("TEST-NORMAL-U2", "正常町1-1", 101);
const failedOrder = makeOrder("TEST-FAILED-U2", "失敗町2-2", 102);
await initializeOrderData([normalOrder, failedOrder]);
baseFake.setWorkflowBaseOrders([normalOrder, failedOrder]);
baseFake.setWorkflowFetchFailures([failedOrder.unique_key]);

const refetchResponse = await post(refetchRoute, "/api/orders/refetch");
assert.equal(refetchResponse.status, 200);
const refetchBody = await refetchResponse.json();
assert.equal(refetchBody.diff_result.has_fetch_failures, true);
assert.deepEqual(refetchBody.diff_result.failed_unique_keys, [failedOrder.unique_key]);

const confirmResponse = await post(diffConfirmRoute, "/api/orders/diff-confirm");
assert.equal(confirmResponse.status, 200);
assert.equal((await confirmResponse.json()).success, true);

const startResponse = await post(sessionStartRoute, "/api/session/start", {
  selected_unique_keys: [normalOrder.unique_key],
});
assert.equal(startResponse.status, 200);
assert.equal((await startResponse.json()).success, true);
assert.ok(await redis.get("session:current"));

await clearMemoryRedis();
const bundleNormal = makeOrder("TEST-BUNDLE-NORMAL", "同梱町3-3", 201);
const bundleFailed = makeOrder("TEST-BUNDLE-FAILED", "同梱町3-3", 202);
await initializeOrderData([bundleNormal, bundleFailed]);
baseFake.setWorkflowBaseOrders([bundleNormal, bundleFailed]);

// cycle 1: 両注文が成功。次cycleの失敗を過去の成功で通さないための前提。
baseFake.setWorkflowFetchFailures([]);
assert.equal((await post(refetchRoute, "/api/orders/refetch")).status, 200);
assert.equal((await post(diffConfirmRoute, "/api/orders/diff-confirm")).status, 200);

// cycle 2: 同じU2の1件が失敗。正常注文だけ選択してもU2展開後に拒否される。
baseFake.setWorkflowFetchFailures([bundleFailed.unique_key]);
assert.equal((await post(refetchRoute, "/api/orders/refetch")).status, 200);
assert.equal((await post(diffConfirmRoute, "/api/orders/diff-confirm")).status, 200);
const rejectedResponse = await post(sessionStartRoute, "/api/session/start", {
  selected_unique_keys: [bundleNormal.unique_key],
});
assert.equal(rejectedResponse.status, 409);
const rejectedBody = await rejectedResponse.json();
assert.deepEqual(rejectedBody.blocked_orders, [
  {
    unique_key: bundleFailed.unique_key,
    reason: "fetch_failed",
    issues: [],
  },
]);
assert.equal(await redis.get("session:current"), null);
const failureView = buildSessionStartFailure(rejectedBody);
assert.ok(failureView);
const failureHtml = renderToStaticMarkup(
  createElement(SessionStartRecoveryPanel, {
    failure: failureView,
    isRefetching: false,
    onRefetch() {},
    onClearSelection() {},
  })
);
assert.match(failureHtml, /TEST-BUNDLE-FAILED/);
assert.match(failureHtml, /今回の再取得で注文詳細を取得できませんでした/);
assert.match(failureHtml, /再取得する/);
assert.match(failureHtml, /選択を解除して注文一覧に戻る/);
assert.doesNotMatch(failureHtml, /緊急解除/);

// cycle 3: 再試行で両注文が成功し、差分確認後に同じ選択が復帰する。
baseFake.setWorkflowFetchFailures([]);
assert.equal((await post(refetchRoute, "/api/orders/refetch")).status, 200);
assert.equal((await post(diffConfirmRoute, "/api/orders/diff-confirm")).status, 200);
const recoveredResponse = await post(sessionStartRoute, "/api/session/start", {
  selected_unique_keys: [bundleNormal.unique_key],
});
assert.equal(recoveredResponse.status, 200);
assert.equal((await recoveredResponse.json()).expanded_unique_key_count, 2);

console.log("order workflow route tests passed");

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.env.APP_ENVIRONMENT = "local";
process.env.BASE_DATA_MODE = "mock";
process.env.APP_STORE_MODE = "memory";

const nativeAbortTimeout = AbortSignal.timeout;
AbortSignal.timeout = () => nativeAbortTimeout(25);

const baseFake = await import("./fakes/workflow-base-api.ts");
const refetchRoute = await import("../app/api/orders/refetch/route.ts");
const { default: RefetchRecoveryPanel, buildRefetchFailure } = await import(
  "../app/orders/components/RefetchRecoveryPanel.ts"
);

try {
  baseFake.setWorkflowBaseOrders([]);
  baseFake.setWorkflowOrderListStall(true);

  const response = await refetchRoute.POST(
    new Request("http://local.test/api/orders/refetch", { method: "POST" })
  );
  const body = await response.json();
  const failure = buildRefetchFailure(body);

  assert.equal(response.status, 503);
  assert.ok(failure);
  assert.equal(failure.retryable, true);

  const html = renderToStaticMarkup(
    createElement(RefetchRecoveryPanel, {
      failure,
      isRefetching: false,
      onRetry() {},
    })
  );

  assert.match(html, /注文一覧と選択状態は維持されています/);
  assert.match(html, /そのまま再取得できます/);
  assert.match(html, /再取得する/);
  assert.doesNotMatch(html, /緊急解除/);
} finally {
  AbortSignal.timeout = nativeAbortTimeout;
}

console.log("refetch recovery UI tests passed");

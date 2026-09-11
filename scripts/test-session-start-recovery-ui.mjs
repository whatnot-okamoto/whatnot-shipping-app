import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SessionStartRecoveryPanel, {
  buildSessionStartFailure,
} from "../app/orders/components/SessionStartRecoveryPanel.ts";

const failure = buildSessionStartFailure({
  error: "ORDER_NOT_ELIGIBLE: アプリで処理できない注文が含まれています",
  blocked_orders: [
    {
      unique_key: "TEST-ORDER-FAILED",
      reason: "fetch_failed",
      issues: [],
    },
  ],
});

assert.ok(failure);
assert.equal(failure.orders[0].uniqueKey, "TEST-ORDER-FAILED");
assert.match(failure.orders[0].reason, /取得/);
assert.match(failure.orders[0].nextAction, /再取得/);

const html = renderToStaticMarkup(
  createElement(SessionStartRecoveryPanel, {
    failure,
    isRefetching: false,
    onRefetch() {},
    onClearSelection() {},
  })
);

assert.match(html, /BASE注文ID/);
assert.match(html, /TEST-ORDER-FAILED/);
assert.match(html, /再取得する/);
assert.match(html, /選択を解除して注文一覧に戻る/);
assert.doesNotMatch(html, /緊急解除/);

console.log("session start recovery UI tests passed");

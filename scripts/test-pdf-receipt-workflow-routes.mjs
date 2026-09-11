import assert from "node:assert/strict";

process.env.APP_ENVIRONMENT = "local";
process.env.BASE_DATA_MODE = "mock";
process.env.APP_STORE_MODE = "memory";

const { FIXTURE_DATA } = await import("../lib/pdf-fixture-data.ts");
const { redis } = await import("../lib/upstash.ts");
const { initializeOrderData, getOrderSnapshot } = await import("../lib/order-store.ts");
const baseFake = await import("./fakes/workflow-base-api.ts");
const pdfFake = await import("./fakes/workflow-pdf-generator.ts");
const tokenFake = await import("./fakes/workflow-receipt-share-token.ts");
const pdfRoute = await import("../app/api/pdf/generate/route.ts");
const shareRoute = await import("../app/api/receipts/share/route.ts");
const publicReceiptRoute = await import("../app/receipt/[token]/route.ts");

async function clearMemoryRedis() {
  const keys = await redis.keys("*");
  if (keys.length > 0) await redis.del(...keys);
}

function makeOrder() {
  const order = structuredClone(FIXTURE_DATA["F-01"].order);
  order.unique_key = "TEST-PDF-ORDER";
  order.dispatch_status = "ordered";
  order.shipping_lines[0].shipping_method = "宅配便";
  return order;
}

async function readSession(sessionId) {
  const raw = await redis.get(`session:${sessionId}`);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
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
const normalOrder = makeOrder();
await initializeOrderData([normalOrder]);
const snapshot = await getOrderSnapshot(normalOrder.unique_key);
assert.ok(snapshot);
const sessionId = "fixture-session";
await redis.set("session:current", sessionId);
await redis.set(
  `session:${sessionId}`,
  JSON.stringify({
    session_id: sessionId,
    session_status: "active",
    locked_bundle_group_ids: [snapshot.bundle_group_id],
    refetch_done_flag: true,
    diff_confirmed_flag: true,
    checklist_printed_flag: false,
    pdf_output_done_flag: false,
    csv_status: { nekopos: "pending", sagawa: "pending", yamato: "pending" },
    emergency_unlock_log: [],
  })
);

const blockedOrder = structuredClone(normalOrder);
blockedOrder.cancelled = blockedOrder.ordered + 10;
blockedOrder.order_items[0].status = "cancelled";
baseFake.setWorkflowBaseOrders([blockedOrder]);
pdfFake.resetWorkflowPdfCalls();

const blockedPdfResponse = await post(pdfRoute, "/api/pdf/generate");
assert.equal(blockedPdfResponse.status, 422);
assert.equal((await blockedPdfResponse.json()).outcome, "blocked");
assert.equal(pdfFake.getWorkflowPdfCalls().shippingDocuments, 0);
assert.equal((await readSession(sessionId)).pdf_output_done_flag, false);

baseFake.setWorkflowBaseOrders([normalOrder]);
baseFake.setWorkflowFetchFailures([normalOrder.unique_key]);
const failedPdfResponse = await post(pdfRoute, "/api/pdf/generate");
assert.equal(failedPdfResponse.status, 503);
assert.equal((await failedPdfResponse.json()).outcome, "retryable_error");
assert.equal(pdfFake.getWorkflowPdfCalls().shippingDocuments, 0);
assert.equal((await readSession(sessionId)).pdf_output_done_flag, false);
assert.equal(await redis.get("session:current"), sessionId);

baseFake.setWorkflowFetchFailures([]);
const recoveredPdfResponse = await post(pdfRoute, "/api/pdf/generate");
assert.equal(recoveredPdfResponse.status, 200);
assert.match(recoveredPdfResponse.headers.get("content-type") ?? "", /application\/pdf/);
assert.equal(pdfFake.getWorkflowPdfCalls().shippingDocuments, 1);
assert.equal((await readSession(sessionId)).pdf_output_done_flag, true);

baseFake.setWorkflowBaseOrders([blockedOrder]);
tokenFake.resetWorkflowTokenCalls();
const blockedShareResponse = await post(shareRoute, "/api/receipts/share", {
  unique_key: blockedOrder.unique_key,
  receipt_name: "テスト宛名",
  receipt_note: "商品代として",
});
assert.equal(blockedShareResponse.status, 422);
assert.equal((await blockedShareResponse.json()).outcome, "blocked");
assert.equal(tokenFake.getWorkflowTokenCreateCalls(), 0);

const publicResponse = await publicReceiptRoute.GET(
  new Request("http://local.test/receipt/existing-token"),
  { params: Promise.resolve({ token: "existing-token" }) }
);
assert.equal(publicResponse.status, 422);
const publicHtml = await publicResponse.text();
assert.match(publicHtml, /注文内容の変更などにより/);
assert.match(publicHtml, /ショップへお問い合わせ/);
assert.doesNotMatch(publicHtml, /full_cancel|TEST-PDF-ORDER|商品status|金額項目/);
assert.equal(pdfFake.getWorkflowPdfCalls().receipts, 0);

console.log("PDF and receipt workflow route tests passed");

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

process.env.APP_ENVIRONMENT = "local";
process.env.BASE_DATA_MODE = "mock";
process.env.APP_STORE_MODE = "memory";
process.env.RECEIPT_SHARE_SECRET = "fixture-only-receipt-secret-with-at-least-32-bytes";

const { createCompositeAmountFixture, COMPOSITE_EXPECTED_AMOUNTS } =
  await import("./fixtures/pdf-composite-amount-fixture.mjs");
const { prepareOrderForPdf } = await import("../lib/pdf-order-assessment.ts");
const { buildPdfAmountSummary } = await import("../lib/pdf-amount-summary.ts");
const { generateShippingDocumentsPdf, generateReceiptOnlyPdf } =
  await import("../lib/pdf-generator.ts");
const baseFake = await import("./fakes/workflow-base-api.ts");
const shareRoute = await import("../app/api/receipts/share/route.ts");
const publicReceiptRoute = await import("../app/receipt/[token]/route.ts");

const fixture = createCompositeAmountFixture();
assert.equal(fixture.order.order_discount.discount, 100);
assert.equal(fixture.order.order_header_coin.discount, 50);
assert.equal(fixture.order.order_amount_adjustment.adjusted_amount, 20);
assert.equal(
  COMPOSITE_EXPECTED_AMOUNTS.itemsSubtotal +
    COMPOSITE_EXPECTED_AMOUNTS.shippingFee +
    COMPOSITE_EXPECTED_AMOUNTS.codFee -
    fixture.order.order_discount.discount -
    fixture.order.order_header_coin.discount +
    fixture.order.order_amount_adjustment.adjusted_amount,
  COMPOSITE_EXPECTED_AMOUNTS.total
);
const prepared = prepareOrderForPdf(fixture.order);
assert.equal(prepared.assessment.generationOutcome, "eligible");
assert.equal(prepared.assessment.cancellationState, "partial_cancel");
assert.deepEqual(
  prepared.order.order_items.map((item) => item.order_item_id),
  [1601, 1602]
);
assert.deepEqual(buildPdfAmountSummary(prepared.order), COMPOSITE_EXPECTED_AMOUNTS);
const noShippingLine = structuredClone(prepared.order);
noShippingLine.shipping_lines = [];
assert.throws(
  () => buildPdfAmountSummary(noShippingLine),
  /requires one verified shipping line/
);

const zeroYenReducedRate = structuredClone(prepared.order);
zeroYenReducedRate.order_items = [
  { ...zeroYenReducedRate.order_items[0], amount: 1, price: 0, total: 0 },
  zeroYenReducedRate.order_items[1],
];
assert.equal(
  buildPdfAmountSummary(zeroYenReducedRate).hasReducedRateItem,
  true,
  "8% display mode is selected by item presence even when its subtotal is zero"
);

const shippingBytes = await generateShippingDocumentsPdf([
  { order: prepared.order, orderState: fixture.orderState },
]);
const receiptOnlyBytes = await generateReceiptOnlyPdf([
  { order: prepared.order, orderState: fixture.orderState },
]);
assert.equal((await PDFDocument.load(shippingBytes)).getPageCount(), 2);
assert.equal((await PDFDocument.load(receiptOnlyBytes)).getPageCount(), 1);

baseFake.setWorkflowBaseOrders([fixture.order]);
const shareResponse = await shareRoute.POST(
  new Request("http://local.test/api/receipts/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      unique_key: fixture.order.unique_key,
      receipt_name: fixture.orderState.receipt_name,
      receipt_note: fixture.orderState.receipt_note,
    }),
  })
);
assert.equal(shareResponse.status, 200);
const shareBody = await shareResponse.json();
assert.equal(shareBody.order.total, COMPOSITE_EXPECTED_AMOUNTS.total);
assert.equal(shareBody.order.cancellationState, "partial_cancel");
const sharePath = new URL(shareBody.share_url).pathname;
const token = decodeURIComponent(sharePath.slice("/receipt/".length));
assert.ok(token.length > 0);

const publicResponse = await publicReceiptRoute.GET(
  new Request(`http://local.test${sharePath}`),
  { params: Promise.resolve({ token }) }
);
assert.equal(publicResponse.status, 200);
assert.match(publicResponse.headers.get("content-type") ?? "", /application\/pdf/);
const publicBytes = new Uint8Array(await publicResponse.arrayBuffer());
assert.equal((await PDFDocument.load(publicBytes)).getPageCount(), 1);

const outputDir = process.argv[2];
if (outputDir) {
  assert.ok(path.isAbsolute(outputDir), "PDF output directory must be absolute");
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "composite-shipping-documents.pdf"), shippingBytes),
    writeFile(path.join(outputDir, "composite-receipt-only.pdf"), receiptOnlyBytes),
    writeFile(path.join(outputDir, "composite-shared-receipt.pdf"), publicBytes),
  ]);
}

console.log("composite PDF workflow tests passed");

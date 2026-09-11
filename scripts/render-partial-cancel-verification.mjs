import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FIXTURE_DATA } from "../lib/pdf-fixture-data.ts";
import { generateShippingDocumentsPdf } from "../lib/pdf-generator.ts";
import { prepareOrderForPdf } from "../lib/pdf-order-assessment.ts";

const outputDir = path.join(process.cwd(), "tmp", "pdfs");
await mkdir(outputDir, { recursive: true });

const normalFixture = structuredClone(FIXTURE_DATA["F-01"]);
const partialFixture = structuredClone(FIXTURE_DATA["F-01"]);
for (const fixture of [normalFixture, partialFixture]) {
  fixture.orderState.receipt_required = true;
  fixture.orderState.receipt_name = "検証用御中";
  fixture.orderState.receipt_note = "検証用商品代として";
}
partialFixture.order.unique_key = "FIXTURE-PARTIAL-CANCEL";
partialFixture.orderState.unique_key = partialFixture.order.unique_key;
partialFixture.order.order_items.push({
  ...partialFixture.order.order_items[0],
  order_item_id: 999,
  item_id: 99900,
  title: "キャンセル済み検証商品（PDF非表示）",
  barcode: "4900000000999",
  status: "cancelled",
  consumption_tax_rate: 8,
  price: 9999,
  total: 9999,
  item_total: 9999,
});
partialFixture.order.shipping_lines[0].order_item_ids = ["1", "999"];

const normal = prepareOrderForPdf(normalFixture.order);
const partial = prepareOrderForPdf(partialFixture.order);
if (normal.assessment.generationOutcome !== "eligible") {
  throw new Error("normal fixture is not eligible");
}
if (
  partial.assessment.generationOutcome !== "eligible" ||
  partial.assessment.cancellationState !== "partial_cancel"
) {
  throw new Error("partial-cancel fixture is not eligible");
}

const [normalPdf, partialPdf] = await Promise.all([
  generateShippingDocumentsPdf([
    { order: normal.order, orderState: normalFixture.orderState },
  ]),
  generateShippingDocumentsPdf([
    { order: partial.order, orderState: partialFixture.orderState },
  ]),
]);

const normalPath = path.join(outputDir, "normal-order.pdf");
const partialPath = path.join(outputDir, "partial-cancel-order.pdf");
await Promise.all([
  writeFile(normalPath, normalPdf),
  writeFile(partialPath, partialPdf),
]);

console.log(`normal=${normalPath}`);
console.log(`partial=${partialPath}`);

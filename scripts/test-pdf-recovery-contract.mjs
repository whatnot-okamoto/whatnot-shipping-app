import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const [
  pdfRoute,
  pdfUi,
  receiptOrderRoute,
  receiptShareRoute,
  receiptUi,
  publicReceiptRoute,
] = await Promise.all([
  source("app/api/pdf/generate/route.ts"),
  source("app/orders/components/PdfOutputSection.tsx"),
  source("app/api/receipts/order/route.ts"),
  source("app/api/receipts/share/route.ts"),
  source("app/receipts/page.tsx"),
  source("app/receipt/[token]/route.ts"),
]);

assert(pdfRoute.includes('outcome: "retryable_error"'));
assert(pdfRoute.includes('outcome: "blocked"'));
assert(pdfRoute.includes('outcome: "fatal_error"'));
assert(
  pdfRoute.indexOf("if (failedOrders.length > 0)") <
    pdfRoute.indexOf("const updatedSession"),
  "failed detail fetches must return before the PDF-done flag is updated"
);
assert(
  pdfRoute.indexOf("if (blockedOrders.length > 0)") <
    pdfRoute.indexOf("const updatedSession"),
  "blocked orders must return before the PDF-done flag is updated"
);

assert(pdfUi.includes("緊急セッション解除は不要です"));
assert(pdfUi.includes("同じU2内の注文だけを切り離すことはできません"));
assert(pdfUi.includes("重複取込・重複発行"));
assert(pdfUi.includes("setIsGenerating(false)"));

assert(receiptOrderRoute.includes("{ order: summary }"));
assert(receiptOrderRoute.includes('outcome: "retryable_error"'));
assert(
  receiptShareRoute.indexOf('assessment.generationOutcome === "blocked"') <
    receiptShareRoute.indexOf("const { token, payload } = createReceiptShareToken"),
  "blocked receipt orders must be rejected before a share token is created"
);
assert(receiptUi.includes("この領収書専用画面は出荷セッションと無関係"));
assert(receiptUi.includes('order.generationOutcome === "blocked"'));

assert(publicReceiptRoute.includes("注文内容の変更などにより"));
assert(!publicReceiptRoute.includes("GENERATION_ISSUE_LABELS"));
assert(!publicReceiptRoute.includes("緊急セッション解除"));

console.log("PDF recovery contract tests passed");

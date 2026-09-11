let shippingDocumentCalls = 0;
let receiptCalls = 0;

export function resetWorkflowPdfCalls(): void {
  shippingDocumentCalls = 0;
  receiptCalls = 0;
}

export function getWorkflowPdfCalls(): { shippingDocuments: number; receipts: number } {
  return { shippingDocuments: shippingDocumentCalls, receipts: receiptCalls };
}

export function checkTaxRates() {
  return { ok: true as const };
}

export function checkPaymentLabels() {
  return {
    hasUnknownPayment: false,
    unknownPaymentValues: [],
    affectedCount: 0,
  };
}

export async function generateShippingDocumentsPdf(): Promise<Uint8Array> {
  shippingDocumentCalls += 1;
  return new Uint8Array([37, 80, 68, 70]);
}

export async function generateReceiptOnlyPdf(): Promise<Uint8Array> {
  receiptCalls += 1;
  return new Uint8Array([37, 80, 68, 70]);
}

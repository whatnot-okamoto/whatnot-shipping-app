import type { BaseOrder } from "@/lib/base-api";
import { fetchOrderDetail } from "@/lib/base-api";
import {
  checkPaymentLabels,
  checkTaxRates,
  generateReceiptOnlyPdf,
} from "@/lib/pdf-generator";
import { PAYMENT_LABELS } from "@/lib/pdf-config";
import type { U1Data } from "@/lib/order-store";
import type { ReceiptSharePayload } from "@/lib/receipt-share-token";

const NORMAL_RECEIPT_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

export type ReceiptOrderSummary = {
  uniqueKey: string;
  purchaserName: string;
  ordered: number;
  dispatched: number | null;
  cancelled: number | null;
  dispatchStatus: string;
  paymentCode: string;
  paymentLabel: string;
  total: number;
  warnings: string[];
  hasUnknownPayment: boolean;
};

export type ReceiptPreparation = {
  order: BaseOrder;
  summary: ReceiptOrderSummary;
};

export class ReceiptGenerationError extends Error {
  readonly code: "tax_unknown";

  constructor(code: "tax_unknown", message: string) {
    super(message);
    this.name = "ReceiptGenerationError";
    this.code = code;
  }
}

function buildWarnings(order: BaseOrder, now: number): string[] {
  const warnings: string[] = [];

  if (order.cancelled !== null) {
    warnings.push(
      "キャンセル情報がある注文です。発行してよい注文か確認してください。"
    );
  }
  if (order.dispatch_status !== "dispatched" || order.dispatched === null) {
    warnings.push(
      "BASE上で発送済みを確認できない注文です。現在の状況を確認してください。"
    );
  }
  if (
    order.dispatched !== null &&
    now - order.dispatched * 1000 > NORMAL_RECEIPT_WINDOW_MS
  ) {
    warnings.push(
      "通常受付期間（発送完了から365日）を超えています。発行可否を確認してください。"
    );
  }

  return warnings;
}

export function buildReceiptOrderSummary(
  order: BaseOrder,
  now = Date.now()
): ReceiptOrderSummary {
  const paymentCheck = checkPaymentLabels([order]);
  return {
    uniqueKey: order.unique_key,
    purchaserName: `${order.last_name}${order.first_name}`,
    ordered: order.ordered,
    dispatched: order.dispatched,
    cancelled: order.cancelled,
    dispatchStatus: order.dispatch_status,
    paymentCode: order.payment,
    paymentLabel: PAYMENT_LABELS[order.payment] ?? order.payment,
    total: order.total,
    warnings: buildWarnings(order, now),
    hasUnknownPayment: paymentCheck.hasUnknownPayment,
  };
}

export function assertReceiptCanBeRendered(order: BaseOrder): void {
  const taxCheck = checkTaxRates([order]);
  if (!taxCheck.ok) {
    throw new ReceiptGenerationError(
      "tax_unknown",
      "税率情報を確認できない商品が含まれています。"
    );
  }
}

export async function prepareReceiptOrder(
  uniqueKey: string
): Promise<ReceiptPreparation> {
  const order = await fetchOrderDetail(uniqueKey);
  assertReceiptCanBeRendered(order);
  return {
    order,
    summary: buildReceiptOrderSummary(order),
  };
}

function buildReceiptOrderState(
  payload: ReceiptSharePayload,
  order: BaseOrder
): U1Data {
  return {
    unique_key: payload.uniqueKey,
    hold_flag: false,
    hold_reason: "",
    carrier: "",
    receipt_required: true,
    receipt_name: payload.receiptName,
    receipt_note: payload.receiptNote,
    app_memo: "",
    cancelled_flag: order.cancelled !== null,
  };
}

export async function generateSharedReceiptPdf(
  payload: ReceiptSharePayload
): Promise<{ pdfBytes: Uint8Array; uniqueKeySuffix: string }> {
  const order = await fetchOrderDetail(payload.uniqueKey);
  assertReceiptCanBeRendered(order);
  const orderState = buildReceiptOrderState(payload, order);
  const pdfBytes = await generateReceiptOnlyPdf([{ order, orderState }]);

  return {
    pdfBytes,
    uniqueKeySuffix: order.unique_key.slice(-8),
  };
}

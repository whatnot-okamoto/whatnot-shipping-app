import type { BaseOrder } from "@/lib/base-api";
import { fetchOrderDetail } from "@/lib/base-api";
import {
  checkPaymentLabels,
  generateReceiptOnlyPdf,
} from "@/lib/pdf-generator";
import { PAYMENT_LABELS } from "@/lib/pdf-config";
import type { U1Data } from "@/lib/order-store";
import type { ReceiptSharePayload } from "@/lib/receipt-share-token";
import {
  prepareOrderForPdf,
  type CancellationState,
  type GenerationIssueCode,
  type OrderGenerationAssessment,
} from "@/lib/pdf-order-assessment";

const NORMAL_RECEIPT_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

export type ReceiptOrderSummary = {
  unique_key: string;
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
  cancellationState: CancellationState;
  generationOutcome: "eligible" | "blocked";
  issues: GenerationIssueCode[];
};

export type ReceiptPreparation = {
  order: BaseOrder;
  summary: ReceiptOrderSummary;
  assessment: OrderGenerationAssessment;
};

export class ReceiptGenerationError extends Error {
  readonly code: "blocked";
  readonly issues: GenerationIssueCode[];

  constructor(issues: GenerationIssueCode[]) {
    const message = "この注文は現在の内容では領収書を生成できません。";
    super(message);
    this.name = "ReceiptGenerationError";
    this.code = "blocked";
    this.issues = issues;
  }
}

export class ReceiptOrderFetchError extends Error {
  constructor() {
    super("BASE注文詳細を取得できませんでした。");
    this.name = "ReceiptOrderFetchError";
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
  now = Date.now(),
  assessment = prepareOrderForPdf(order).assessment
): ReceiptOrderSummary {
  const paymentCheck = checkPaymentLabels([order]);
  return {
    unique_key: order.unique_key,
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
    cancellationState: assessment.cancellationState,
    generationOutcome: assessment.generationOutcome,
    issues: assessment.issues,
  };
}

export function assertReceiptCanBeRendered(order: BaseOrder): BaseOrder {
  const prepared = prepareOrderForPdf(order);
  if (prepared.assessment.generationOutcome === "blocked") {
    throw new ReceiptGenerationError(prepared.assessment.issues);
  }
  return prepared.order;
}

export async function prepareReceiptOrder(
  uniqueKey: string
): Promise<ReceiptPreparation> {
  let order: BaseOrder;
  try {
    order = await fetchOrderDetail(uniqueKey);
  } catch {
    throw new ReceiptOrderFetchError();
  }
  const assessment = prepareOrderForPdf(order).assessment;
  return {
    order,
    assessment,
    summary: buildReceiptOrderSummary(order, Date.now(), assessment),
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
  const preparedOrder = assertReceiptCanBeRendered(order);
  const orderState = buildReceiptOrderState(payload, preparedOrder);
  const pdfBytes = await generateReceiptOnlyPdf([{ order: preparedOrder, orderState }]);

  return {
    pdfBytes,
    uniqueKeySuffix: order.unique_key.slice(-8),
  };
}

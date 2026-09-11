import type { BaseOrder, BaseOrderItem } from "./base-api";

export type CancellationState =
  | "normal"
  | "partial_cancel"
  | "full_cancel"
  | "cancellation_state_unknown";

export type GenerationIssueCode =
  | "full_cancel"
  | "cancellation_state_unknown"
  | "amount_inconsistent"
  | "unit_price_unknown"
  | "shipping_data_unknown"
  | "multiple_shipping_lines_unsupported"
  | "order_data_invalid"
  | "tax_rate_unknown"
  | "not_in_open_orders";

export type OrderGenerationAssessment = {
  cancellationState: CancellationState;
  generationOutcome: "eligible" | "blocked";
  issues: GenerationIssueCode[];
};

export type PreparedPdfOrder = {
  order: BaseOrder;
  assessment: OrderGenerationAssessment;
};

type AmountPath = { complete: true; value: number } | { complete: false };
type ResolvedItem = { item: BaseOrderItem; unitPrice: number; lineTotal: number };

const ACTIVE_STATUSES = new Set(["ordered", "dispatched"]);
const KNOWN_STATUSES = new Set(["ordered", "dispatched", "cancelled"]);

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkedAdd(left: number, right: number): number | null {
  const value = left + right;
  return Number.isSafeInteger(value) ? value : null;
}

function checkedMultiply(left: number, right: number): number | null {
  const value = left * right;
  return Number.isSafeInteger(value) ? value : null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function resolveItemAmount(
  item: BaseOrderItem
): { resolved: ResolvedItem | null; issue: GenerationIssueCode | null } {
  if (!Number.isSafeInteger(item.amount) || item.amount <= 0) {
    return { resolved: null, issue: "order_data_invalid" };
  }

  const direct: AmountPath = hasOwn(item, "total")
    ? isSafeNonNegativeInteger(item.total)
      ? { complete: true, value: item.total }
      : { complete: false }
    : { complete: false };
  if (hasOwn(item, "total") && !isSafeNonNegativeInteger(item.total)) {
    return { resolved: null, issue: "order_data_invalid" };
  }

  const hasItemTotal = hasOwn(item, "item_total");
  const hasOptionTotal = hasOwn(item, "option_total");
  if (
    (hasItemTotal && !isSafeNonNegativeInteger(item.item_total)) ||
    (hasOptionTotal && !isSafeNonNegativeInteger(item.option_total))
  ) {
    return { resolved: null, issue: "order_data_invalid" };
  }
  let component: AmountPath = { complete: false };
  if (
    hasItemTotal &&
    hasOptionTotal &&
    isSafeNonNegativeInteger(item.item_total) &&
    isSafeNonNegativeInteger(item.option_total)
  ) {
    const value = checkedAdd(item.item_total, item.option_total);
    if (value === null) return { resolved: null, issue: "order_data_invalid" };
    component = { complete: true, value };
  }

  const hasPrice = hasOwn(item, "price");
  if (hasPrice && !isSafeNonNegativeInteger(item.price)) {
    return { resolved: null, issue: "order_data_invalid" };
  }
  let reconstructed: AmountPath = { complete: false };
  let reconstructedUnit: number | null = null;
  if (hasPrice && hasOwn(item, "options")) {
    if (!Array.isArray(item.options)) {
      return { resolved: null, issue: "order_data_invalid" };
    }
    let optionUnitTotal = 0;
    for (const option of item.options) {
      if (!option || !isSafeNonNegativeInteger(option.price)) {
        return { resolved: null, issue: "order_data_invalid" };
      }
      const next = checkedAdd(optionUnitTotal, option.price);
      if (next === null) return { resolved: null, issue: "order_data_invalid" };
      optionUnitTotal = next;
    }
    reconstructedUnit = checkedAdd(item.price, optionUnitTotal);
    const value =
      reconstructedUnit === null
        ? null
        : checkedMultiply(reconstructedUnit, item.amount);
    if (value === null) return { resolved: null, issue: "order_data_invalid" };
    reconstructed = { complete: true, value };
  }

  const completePaths = [direct, component, reconstructed].filter(
    (path): path is Extract<AmountPath, { complete: true }> => path.complete
  );
  if (completePaths.length === 0) {
    return { resolved: null, issue: "order_data_invalid" };
  }
  const values = new Set(completePaths.map((path) => path.value));
  if (values.size !== 1) {
    return { resolved: null, issue: "amount_inconsistent" };
  }

  // 行金額は total → item_total + option_total → 再構成値の順で採用する。
  // 複数経路が完全な場合は上で一致済みなので、優先順位で金額差は生じない。
  const lineTotal = direct.complete
    ? direct.value
    : component.complete
      ? component.value
      : (reconstructed as Extract<AmountPath, { complete: true }>).value;
  // 表示単価は price + options が完全ならそれを優先し、なければ行金額を
  // 数量で割り切れる場合だけ採用する。「—」での警告付き出力は行わない。
  const unitPrice =
    reconstructedUnit !== null && reconstructed.complete
      ? reconstructedUnit
      : lineTotal % item.amount === 0
        ? lineTotal / item.amount
        : null;
  if (unitPrice === null || !Number.isSafeInteger(unitPrice)) {
    return { resolved: null, issue: "unit_price_unknown" };
  }
  return { resolved: { item, unitPrice, lineTotal }, issue: null };
}

export function assessOrderForPdf(order: BaseOrder): OrderGenerationAssessment {
  const issues: GenerationIssueCode[] = [];
  const items = Array.isArray(order.order_items) ? order.order_items : [];
  const statuses = items.map((item) => item?.status);
  const statusUnknown =
    items.length === 0 ||
    statuses.some(
      (status) => typeof status !== "string" || !KNOWN_STATUSES.has(status)
    );

  const activeCount = statuses.filter(
    (status) => typeof status === "string" && ACTIVE_STATUSES.has(status)
  ).length;
  const cancelledCount = statuses.filter((status) => status === "cancelled").length;

  let cancellationState: CancellationState;
  if (statusUnknown) {
    cancellationState = "cancellation_state_unknown";
    issues.push("cancellation_state_unknown");
  } else if (cancelledCount > 0 && activeCount === 0) {
    cancellationState = "full_cancel";
    issues.push("full_cancel");
  } else if (cancelledCount > 0) {
    cancellationState = "partial_cancel";
  } else {
    cancellationState = "normal";
  }

  if (!Array.isArray(order.shipping_lines) || order.shipping_lines.length === 0) {
    issues.push("shipping_data_unknown");
  } else if (order.shipping_lines.length > 1) {
    issues.push("multiple_shipping_lines_unsupported");
  } else if (!isSafeNonNegativeInteger(order.shipping_lines[0]?.shipping_fee)) {
    issues.push("order_data_invalid");
  }

  if (!isSafeNonNegativeInteger(order.total)) {
    issues.push("order_data_invalid");
  }

  if (!statusUnknown && activeCount > 0) {
    for (const item of items.filter((candidate) => ACTIVE_STATUSES.has(candidate.status))) {
      const { issue } = resolveItemAmount(item);
      if (issue) issues.push(issue);
      const rate = item.consumption_tax_rate;
      if (rate !== 8 && rate !== 10) issues.push("tax_rate_unknown");
    }
  }

  const uniqueIssues = [...new Set(issues)];
  return {
    cancellationState,
    generationOutcome: uniqueIssues.length === 0 ? "eligible" : "blocked",
    issues: uniqueIssues,
  };
}

export function prepareOrderForPdf(order: BaseOrder): PreparedPdfOrder {
  const assessment = assessOrderForPdf(order);
  if (assessment.generationOutcome === "blocked") {
    return { order, assessment };
  }

  const activeItems = order.order_items
    .filter((item) => ACTIVE_STATUSES.has(item.status))
    .map((item) => {
      const result = resolveItemAmount(item);
      if (!result.resolved) {
        throw new Error("Eligible PDF order did not resolve to renderable items.");
      }
      return {
        ...item,
        price: result.resolved.unitPrice,
        total: result.resolved.lineTotal,
      };
    });

  return {
    assessment,
    order: { ...order, order_items: activeItems },
  };
}

export function prepareOrdersForPdf(orders: BaseOrder[]): {
  preparedOrders: BaseOrder[];
  assessments: Array<{ unique_key: string; assessment: OrderGenerationAssessment }>;
} {
  const results = orders.map((order) => ({
    unique_key: order.unique_key,
    prepared: prepareOrderForPdf(order),
  }));
  return {
    preparedOrders: results
      .filter((result) => result.prepared.assessment.generationOutcome === "eligible")
      .map((result) => result.prepared.order),
    assessments: results.map((result) => ({
      unique_key: result.unique_key,
      assessment: result.prepared.assessment,
    })),
  };
}

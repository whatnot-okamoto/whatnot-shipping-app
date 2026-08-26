type UnknownRecord = Record<string, unknown>;

export type CancellationCandidate =
  | "normal"
  | "partial_cancel"
  | "full_cancel"
  | "indeterminate";

export type AmountRelation =
  | "explained"
  | "unexplained_difference"
  | "indeterminate";

export type TaxRateComposition =
  | "8_only"
  | "10_only"
  | "mixed_8_10"
  | "indeterminate";

export type PartialCancelDiagnostic = {
  topLevelCancelled: "null" | "value" | "missing";
  knownItemStatuses: Array<"ordered" | "cancelled" | "dispatched">;
  unknownItemStatusPresent: boolean;
  cancellationCandidate: CancellationCandidate;
  cancelledItemsRemainInOrderItems: "yes" | "no" | "indeterminate";
  amountRelation: AmountRelation;
  taxRateComposition: TaxRateComposition;
};

const KNOWN_ITEM_STATUSES = new Set([
  "ordered",
  "cancelled",
  "dispatched",
] as const);

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalNestedAmount(
  order: UnknownRecord,
  objectKey: string,
  amountKey: string
): { known: boolean; value: number } {
  const container = order[objectKey];
  if (container === undefined || container === null) {
    return { known: true, value: 0 };
  }
  const record = asRecord(container);
  const amount = record ? asFiniteNumber(record[amountKey]) : null;
  return amount === null
    ? { known: false, value: 0 }
    : { known: true, value: amount };
}

function optionalTopLevelAmount(
  order: UnknownRecord,
  key: string
): { known: boolean; value: number } {
  const value = order[key];
  if (value === undefined || value === null) {
    return { known: true, value: 0 };
  }
  const amount = asFiniteNumber(value);
  return amount === null
    ? { known: false, value: 0 }
    : { known: true, value: amount };
}

function getShippingAmount(
  order: UnknownRecord
): { known: boolean; value: number } {
  const shippingLines = order.shipping_lines;
  if (Array.isArray(shippingLines) && shippingLines.length > 0) {
    let total = 0;
    for (const line of shippingLines) {
      const amount = asFiniteNumber(asRecord(line)?.shipping_fee);
      if (amount === null) return { known: false, value: 0 };
      total += amount;
    }
    return { known: true, value: total };
  }
  return optionalTopLevelAmount(order, "shipping_fee");
}

function deriveAmountRelation(
  order: UnknownRecord,
  items: UnknownRecord[],
  statuses: string[]
): AmountRelation {
  const orderTotal = asFiniteNumber(order.total);
  if (orderTotal === null || items.length === 0 || statuses.length !== items.length) {
    return "indeterminate";
  }

  let activeItemTotal = 0;
  for (let index = 0; index < items.length; index += 1) {
    const status = statuses[index];
    if (!KNOWN_ITEM_STATUSES.has(status as never)) return "indeterminate";
    if (status === "cancelled") continue;
    const price = asFiniteNumber(items[index].price);
    const amount = asFiniteNumber(items[index].amount);
    if (price === null || amount === null) return "indeterminate";
    activeItemTotal += price * amount;
  }

  const discount = optionalNestedAmount(order, "order_discount", "discount");
  const coinDiscount = optionalNestedAmount(
    order,
    "order_header_coin",
    "discount"
  );
  const adjustment = optionalNestedAmount(
    order,
    "order_amount_adjustment",
    "adjusted_amount"
  );
  const codFee = optionalTopLevelAmount(order, "cod_fee");
  const shipping = getShippingAmount(order);
  const components = [discount, coinDiscount, adjustment, codFee, shipping];
  if (components.some((component) => !component.known)) {
    return "indeterminate";
  }

  const subtotal =
    activeItemTotal -
    discount.value -
    coinDiscount.value +
    adjustment.value +
    codFee.value;

  // BASE公式説明と実データ差異に備え、送料を含む式・含まない式の
  // どちらかで説明できればexplainedとする。どちらにも一致しない場合も
  // 「不一致」と断定せず、未説明差額ありとして扱う。
  return orderTotal === subtotal || orderTotal === subtotal + shipping.value
    ? "explained"
    : "unexplained_difference";
}

function deriveTaxRateComposition(items: UnknownRecord[]): TaxRateComposition {
  if (items.length === 0) return "indeterminate";
  const rates = new Set<number>();
  for (const item of items) {
    const rate = asFiniteNumber(item.consumption_tax_rate);
    if (rate !== 8 && rate !== 10) return "indeterminate";
    rates.add(rate);
  }
  if (rates.size === 2) return "mixed_8_10";
  return rates.has(8) ? "8_only" : "10_only";
}

export function analyzePartialCancellation(
  rawOrder: unknown
): PartialCancelDiagnostic {
  const order = asRecord(rawOrder);
  if (!order) {
    throw new Error("Order payload is not an object.");
  }

  const topLevelCancelled = !("cancelled" in order)
    ? "missing"
    : order.cancelled === null
      ? "null"
      : "value";

  const rawItems = Array.isArray(order.order_items) ? order.order_items : [];
  const items = rawItems.map(asRecord).filter((item): item is UnknownRecord => item !== null);
  const itemsStructureValid = rawItems.length > 0 && items.length === rawItems.length;
  const statuses = items.map((item) =>
    typeof item.status === "string" ? item.status : ""
  );
  const knownItemStatuses = [
    ...new Set(
      statuses.filter((status): status is "ordered" | "cancelled" | "dispatched" =>
        KNOWN_ITEM_STATUSES.has(status as never)
      )
    ),
  ].sort();
  const unknownItemStatusPresent =
    !itemsStructureValid ||
    statuses.some((status) => !KNOWN_ITEM_STATUSES.has(status as never));
  const hasCancelled = statuses.includes("cancelled");
  const hasActive = statuses.some(
    (status) => status === "ordered" || status === "dispatched"
  );

  let cancellationCandidate: CancellationCandidate = "indeterminate";
  if (!unknownItemStatusPresent) {
    if (hasCancelled && hasActive) cancellationCandidate = "partial_cancel";
    else if (hasCancelled) cancellationCandidate = "full_cancel";
    else cancellationCandidate = "normal";
  }

  return {
    topLevelCancelled,
    knownItemStatuses,
    unknownItemStatusPresent,
    cancellationCandidate,
    cancelledItemsRemainInOrderItems: unknownItemStatusPresent
      ? "indeterminate"
      : hasCancelled
        ? "yes"
        : "no",
    amountRelation: itemsStructureValid
      ? deriveAmountRelation(order, items, statuses)
      : "indeterminate",
    taxRateComposition: itemsStructureValid
      ? deriveTaxRateComposition(items)
      : "indeterminate",
  };
}

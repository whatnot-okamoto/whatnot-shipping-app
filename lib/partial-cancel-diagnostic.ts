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

function getShippingCandidates(
  order: UnknownRecord,
  items: UnknownRecord[],
  statuses: string[]
): { complete: boolean; malformed: boolean; values: number[] } {
  const values: number[] = [];
  let malformed = false;

  if ("shipping_fee" in order) {
    const topLevel = asFiniteNumber(order.shipping_fee);
    if (topLevel === null) malformed = true;
    else values.push(topLevel);
  }

  if ("shipping_lines" in order) {
    if (Array.isArray(order.shipping_lines)) {
      let total = 0;
      let linesComplete = true;
      for (const line of order.shipping_lines) {
        const amount = asFiniteNumber(asRecord(line)?.shipping_fee);
        if (amount === null) {
          malformed = true;
          linesComplete = false;
          break;
        }
        total += amount;
      }
      if (linesComplete) values.push(total);
    } else if (order.shipping_lines !== null) {
      malformed = true;
    }
  }

  const activeItems = items.filter((_, index) => statuses[index] !== "cancelled");
  if (activeItems.some((item) => "shipping_fee" in item)) {
    let total = 0;
    let itemsComplete = true;
    for (const item of activeItems) {
      if (!("shipping_fee" in item)) {
        malformed = true;
        itemsComplete = false;
        break;
      }
      const amount = asFiniteNumber(item.shipping_fee);
      if (amount === null) {
        malformed = true;
        itemsComplete = false;
        break;
      }
      total += amount;
    }
    if (itemsComplete) values.push(total);
  }

  return {
    complete: values.length > 0 && !malformed && new Set(values).size === 1,
    malformed,
    values: [...new Set(values)],
  };
}

function getOrderItemAmount(
  item: UnknownRecord
): { known: boolean; value: number } {
  const candidates: number[] = [];
  const total = asFiniteNumber(item.total);
  if (total !== null) candidates.push(total);

  const itemTotal = asFiniteNumber(item.item_total);
  const optionTotal = asFiniteNumber(item.option_total);
  if (itemTotal !== null && optionTotal !== null) {
    candidates.push(itemTotal + optionTotal);
  }

  const price = asFiniteNumber(item.price);
  const amount = asFiniteNumber(item.amount);
  const calculatedItemTotal =
    price !== null && amount !== null ? price * amount : null;
  let calculatedOptionTotal: number | null = null;
  if (Array.isArray(item.options) && amount !== null) {
    let optionUnitTotal = 0;
    let optionsComplete = true;
    for (const option of item.options) {
      const optionPrice = asFiniteNumber(asRecord(option)?.price);
      if (optionPrice === null) {
        optionsComplete = false;
        break;
      }
      optionUnitTotal += optionPrice;
    }
    if (optionsComplete) calculatedOptionTotal = optionUnitTotal * amount;
  }

  if (calculatedItemTotal !== null && calculatedOptionTotal !== null) {
    candidates.push(calculatedItemTotal + calculatedOptionTotal);
  }
  if (itemTotal !== null && calculatedOptionTotal !== null) {
    candidates.push(itemTotal + calculatedOptionTotal);
  }
  if (calculatedItemTotal !== null && optionTotal !== null) {
    candidates.push(calculatedItemTotal + optionTotal);
  }

  // 公式サンプルにも経路間の数値競合があるため、完全な経路が複数ある
  // 場合は一致を確認し、一意に定まらなければ判定不能とする。
  const uniqueCandidates = [...new Set(candidates)];
  return uniqueCandidates.length === 1
    ? { known: true, value: uniqueCandidates[0] }
    : { known: false, value: 0 };
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
    const itemAmount = getOrderItemAmount(items[index]);
    if (!itemAmount.known) return "indeterminate";
    activeItemTotal += itemAmount.value;
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
  const components = [discount, coinDiscount, adjustment, codFee];
  if (components.some((component) => !component.known)) {
    return "indeterminate";
  }

  const subtotal =
    activeItemTotal -
    discount.value -
    coinDiscount.value +
    adjustment.value +
    codFee.value;

  // BASE公式のorder.total説明は送料の扱いを明示していないため、まず
  // 記載された式だけで説明できるか確認し、差額がある場合だけ送料を調べる。
  const shipping = getShippingCandidates(order, items, statuses);
  if (shipping.malformed) return "indeterminate";
  if (orderTotal === subtotal) return "explained";
  if (!shipping.complete) return "indeterminate";
  return orderTotal === subtotal + shipping.values[0]
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

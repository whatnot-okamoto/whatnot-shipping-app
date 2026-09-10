type UnknownRecord = Record<string, unknown>;

export const PARTIAL_CANCEL_DIAGNOSTIC_SCHEMA_VERSION =
  "partial-cancel-diagnostic/v2" as const;

export const AMOUNT_PATH_KEYS = [
  "item_total_field",
  "item_plus_option_total",
  "price_plus_options_reconstructed",
] as const;

export const SHIPPING_CANDIDATE_KEYS = [
  "without_shipping",
  "order_shipping_fee",
  "all_shipping_lines",
  "active_shipping_lines_only",
  "active_item_shipping_fee",
] as const;

export const FORMULA_RELATION_KEYS = AMOUNT_PATH_KEYS.flatMap((amountPath) =>
  SHIPPING_CANDIDATE_KEYS.map(
    (shippingCandidate) => `${amountPath}__${shippingCandidate}` as const
  )
);

export type AmountPathKey = (typeof AMOUNT_PATH_KEYS)[number];
export type ShippingCandidateKey = (typeof SHIPPING_CANDIDATE_KEYS)[number];
export type FormulaRelationKey = (typeof FORMULA_RELATION_KEYS)[number];

export type Presence = "present" | "absent";
export type AmountPathPresence =
  | "all_present"
  | "partially_present"
  | "not_present"
  | "invalid";
export type AmountPathAgreement =
  | "all_available_paths_agree"
  | "available_paths_conflict"
  | "single_path_only"
  | "no_complete_path";
export type CancellationCandidate =
  | "normal"
  | "partial_cancel"
  | "full_cancel"
  | "indeterminate";
export type CancellationConsistency =
  | "consistent"
  | "conflict"
  | "indeterminate";
export type TaxRateComposition =
  | "none"
  | "rate_8_only"
  | "rate_10_only"
  | "mixed_8_10"
  | "unknown_rate_present"
  | "indeterminate";
export type ShippingLineItemScope =
  | "no_shipping_lines"
  | "active_items_only"
  | "cancelled_items_only"
  | "active_and_cancelled_items"
  | "unresolvable_or_invalid";
export type OptionalAmountPresence = "absent" | "present" | "invalid";
export type FormulaRelation =
  | "matches"
  | "does_not_match"
  | "unavailable"
  | "invalid";

export type PartialCancelDiagnostic = {
  schemaVersion: typeof PARTIAL_CANCEL_DIAGNOSTIC_SCHEMA_VERSION;
  outcome: "pass_enum_complete" | "stop_indeterminate";
  topLevelCancelled: "null" | "value" | "missing";
  knownItemStatuses: {
    ordered: Presence;
    cancelled: Presence;
    dispatched: Presence;
  };
  unknownItemStatus: "absent" | "present";
  cancellationCandidate: CancellationCandidate;
  cancellationConsistency: CancellationConsistency;
  cancelledItemsRemainInOrderItems: "yes" | "no" | "indeterminate";
  amountPathPresence: {
    active: Record<AmountPathKey, AmountPathPresence>;
    cancelled: Record<AmountPathKey, AmountPathPresence>;
  };
  amountPathAgreement: {
    active: AmountPathAgreement;
    cancelled: AmountPathAgreement;
  };
  taxRateComposition: {
    active: TaxRateComposition;
    cancelled: TaxRateComposition;
  };
  shippingLineItemScope: ShippingLineItemScope;
  adjustmentPresence: {
    discount: OptionalAmountPresence;
    coinDiscount: OptionalAmountPresence;
    adjustment: OptionalAmountPresence;
    codFee: OptionalAmountPresence;
  };
  formulaRelations: Record<FormulaRelationKey, FormulaRelation>;
};

type FieldAmount =
  | { state: "present"; value: number }
  | { state: "absent" | "invalid" };
type ItemPathAmount =
  | { state: "present"; value: number }
  | { state: "absent" | "partial" | "invalid" };
type AggregatePathAmount = {
  presence: AmountPathPresence;
  value: number | null;
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

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function checkedAdd(left: number, right: number): number | null {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

function checkedSubtract(left: number, right: number): number | null {
  const result = left - right;
  return Number.isSafeInteger(result) ? result : null;
}

function checkedMultiply(left: number, right: number): number | null {
  const result = left * right;
  return Number.isSafeInteger(result) ? result : null;
}

function readIntegerField(
  record: UnknownRecord,
  key: string,
  options: { allowNegative?: boolean; strictlyPositive?: boolean } = {}
): FieldAmount {
  if (!hasOwn(record, key)) return { state: "absent" };
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (!options.allowNegative && value < 0) ||
    (options.strictlyPositive && value <= 0)
  ) {
    return { state: "invalid" };
  }
  return { state: "present", value };
}

function deriveTotalFieldPath(item: UnknownRecord): ItemPathAmount {
  return readIntegerField(item, "total");
}

function deriveComponentPath(item: UnknownRecord): ItemPathAmount {
  const itemTotal = readIntegerField(item, "item_total");
  const optionTotal = readIntegerField(item, "option_total");
  if (itemTotal.state === "invalid" || optionTotal.state === "invalid") {
    return { state: "invalid" };
  }
  if (itemTotal.state === "absent" && optionTotal.state === "absent") {
    return { state: "absent" };
  }
  if (itemTotal.state !== "present" || optionTotal.state !== "present") {
    return { state: "partial" };
  }
  const value = checkedAdd(itemTotal.value, optionTotal.value);
  return value === null ? { state: "invalid" } : { state: "present", value };
}

function deriveReconstructedPath(item: UnknownRecord): ItemPathAmount {
  const price = readIntegerField(item, "price");
  const amount = readIntegerField(item, "amount", { strictlyPositive: true });
  const hasOptions = hasOwn(item, "options");

  if (
    price.state === "invalid" ||
    amount.state === "invalid" ||
    (hasOptions && !Array.isArray(item.options))
  ) {
    return { state: "invalid" };
  }
  if (price.state === "absent" && amount.state === "absent" && !hasOptions) {
    return { state: "absent" };
  }
  if (price.state !== "present" || amount.state !== "present" || !hasOptions) {
    return { state: "partial" };
  }

  let optionUnitTotal = 0;
  for (const rawOption of item.options as unknown[]) {
    const option = asRecord(rawOption);
    if (!option) return { state: "invalid" };
    const optionPrice = readIntegerField(option, "price");
    if (optionPrice.state !== "present") return { state: "invalid" };
    const nextTotal = checkedAdd(optionUnitTotal, optionPrice.value);
    if (nextTotal === null) return { state: "invalid" };
    optionUnitTotal = nextTotal;
  }

  const unitTotal = checkedAdd(price.value, optionUnitTotal);
  const value = unitTotal === null ? null : checkedMultiply(unitTotal, amount.value);
  return value === null ? { state: "invalid" } : { state: "present", value };
}

function aggregateItemPath(
  items: UnknownRecord[],
  derive: (item: UnknownRecord) => ItemPathAmount
): AggregatePathAmount {
  if (items.length === 0) return { presence: "not_present", value: null };
  const results = items.map(derive);
  if (results.some((result) => result.state === "invalid")) {
    return { presence: "invalid", value: null };
  }
  if (results.every((result) => result.state === "absent")) {
    return { presence: "not_present", value: null };
  }
  if (!results.every((result) => result.state === "present")) {
    return { presence: "partially_present", value: null };
  }

  let total = 0;
  for (const result of results) {
    if (result.state !== "present") return { presence: "invalid", value: null };
    const nextTotal = checkedAdd(total, result.value);
    if (nextTotal === null) return { presence: "invalid", value: null };
    total = nextTotal;
  }
  return { presence: "all_present", value: total };
}

function derivePathSet(items: UnknownRecord[]): Record<AmountPathKey, AggregatePathAmount> {
  return {
    item_total_field: aggregateItemPath(items, deriveTotalFieldPath),
    item_plus_option_total: aggregateItemPath(items, deriveComponentPath),
    price_plus_options_reconstructed: aggregateItemPath(items, deriveReconstructedPath),
  };
}

function derivePathAgreement(
  paths: Record<AmountPathKey, AggregatePathAmount>
): AmountPathAgreement {
  const values = AMOUNT_PATH_KEYS.flatMap((key) =>
    paths[key].presence === "all_present" && paths[key].value !== null
      ? [paths[key].value]
      : []
  );
  if (values.length === 0) return "no_complete_path";
  if (values.length === 1) return "single_path_only";
  return new Set(values).size === 1
    ? "all_available_paths_agree"
    : "available_paths_conflict";
}

function deriveTaxRateComposition(items: UnknownRecord[]): TaxRateComposition {
  if (items.length === 0) return "none";
  const rates = new Set<number>();
  for (const item of items) {
    if (!hasOwn(item, "consumption_tax_rate") || item.consumption_tax_rate === null) {
      return "indeterminate";
    }
    const rate = item.consumption_tax_rate;
    if (typeof rate !== "number" || !Number.isSafeInteger(rate)) {
      return "indeterminate";
    }
    if (rate !== 8 && rate !== 10) return "unknown_rate_present";
    rates.add(rate);
  }
  if (rates.size === 2) return "mixed_8_10";
  return rates.has(8) ? "rate_8_only" : "rate_10_only";
}

function identifierToString(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 && value.length <= 128 ? String(value) : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return null;
}

type ShippingAnalysis = {
  scope: ShippingLineItemScope;
  allLines: FieldAmount;
  activeLines: FieldAmount;
};

function invalidShipping(): ShippingAnalysis {
  return {
    scope: "unresolvable_or_invalid",
    allLines: { state: "invalid" },
    activeLines: { state: "invalid" },
  };
}

function deriveShippingLines(
  order: UnknownRecord,
  items: UnknownRecord[],
  statuses: string[]
): ShippingAnalysis {
  if (!hasOwn(order, "shipping_lines")) {
    return {
      scope: "no_shipping_lines",
      allLines: { state: "absent" },
      activeLines: { state: "absent" },
    };
  }
  if (!Array.isArray(order.shipping_lines)) return invalidShipping();
  if (order.shipping_lines.length === 0) {
    return {
      scope: "no_shipping_lines",
      allLines: { state: "present", value: 0 },
      activeLines: { state: "present", value: 0 },
    };
  }

  const itemStatusById = new Map<string, string>();
  for (let index = 0; index < items.length; index += 1) {
    const id = identifierToString(items[index].order_item_id);
    if (id === null || itemStatusById.has(id)) return invalidShipping();
    itemStatusById.set(id, statuses[index]);
  }

  let allTotal = 0;
  let activeTotal = 0;
  let activeSeen = false;
  let cancelledSeen = false;
  let mixedLineSeen = false;
  const seenShippingItemIds = new Set<string>();

  for (const rawLine of order.shipping_lines) {
    const line = asRecord(rawLine);
    if (!line || !Array.isArray(line.order_item_ids) || line.order_item_ids.length === 0) {
      return invalidShipping();
    }
    const shippingFee = readIntegerField(line, "shipping_fee");
    if (shippingFee.state !== "present") return invalidShipping();
    const nextAllTotal = checkedAdd(allTotal, shippingFee.value);
    if (nextAllTotal === null) return invalidShipping();
    allTotal = nextAllTotal;

    let lineActive = false;
    let lineCancelled = false;
    for (const rawId of line.order_item_ids) {
      const id = identifierToString(rawId);
      if (id === null || seenShippingItemIds.has(id) || !itemStatusById.has(id)) {
        return invalidShipping();
      }
      seenShippingItemIds.add(id);
      const status = itemStatusById.get(id);
      if (status === "cancelled") lineCancelled = true;
      else if (status === "ordered" || status === "dispatched") lineActive = true;
      else return invalidShipping();
    }
    activeSeen ||= lineActive;
    cancelledSeen ||= lineCancelled;
    if (lineActive && lineCancelled) mixedLineSeen = true;
    if (lineActive && !lineCancelled) {
      const nextActiveTotal = checkedAdd(activeTotal, shippingFee.value);
      if (nextActiveTotal === null) return invalidShipping();
      activeTotal = nextActiveTotal;
    }
  }

  const scope = activeSeen
    ? cancelledSeen
      ? "active_and_cancelled_items"
      : "active_items_only"
    : cancelledSeen
      ? "cancelled_items_only"
      : "unresolvable_or_invalid";

  return {
    scope,
    allLines: { state: "present", value: allTotal },
    activeLines: mixedLineSeen
      ? { state: "invalid" }
      : { state: "present", value: activeTotal },
  };
}

function deriveActiveItemShipping(items: UnknownRecord[]): FieldAmount {
  if (items.length === 0) return { state: "absent" };
  let total = 0;
  for (const item of items) {
    const shippingFee = readIntegerField(item, "shipping_fee");
    if (shippingFee.state !== "present") return shippingFee;
    const nextTotal = checkedAdd(total, shippingFee.value);
    if (nextTotal === null) return { state: "invalid" };
    total = nextTotal;
  }
  return { state: "present", value: total };
}

type AdjustmentAmount = {
  presence: OptionalAmountPresence;
  value: number;
};

function deriveNestedAdjustment(
  order: UnknownRecord,
  objectKey: string,
  amountKey: string,
  allowNegative = false
): AdjustmentAmount {
  if (!hasOwn(order, objectKey)) return { presence: "absent", value: 0 };
  const container = asRecord(order[objectKey]);
  if (!container) return { presence: "invalid", value: 0 };
  const amount = readIntegerField(container, amountKey, { allowNegative });
  return amount.state === "present"
    ? { presence: "present", value: amount.value }
    : { presence: "invalid", value: 0 };
}

function deriveTopLevelAdjustment(order: UnknownRecord, key: string): AdjustmentAmount {
  if (!hasOwn(order, key)) return { presence: "absent", value: 0 };
  const amount = readIntegerField(order, key);
  return amount.state === "present"
    ? { presence: "present", value: amount.value }
    : { presence: "invalid", value: 0 };
}

function applyDocumentedAdjustments(
  base: number,
  adjustments: {
    discount: AdjustmentAmount;
    coinDiscount: AdjustmentAmount;
    adjustment: AdjustmentAmount;
    codFee: AdjustmentAmount;
  }
): number | null {
  if (Object.values(adjustments).some((item) => item.presence !== "present")) {
    return null;
  }
  const afterDiscount = checkedSubtract(base, adjustments.discount.value);
  const afterCoin =
    afterDiscount === null
      ? null
      : checkedSubtract(afterDiscount, adjustments.coinDiscount.value);
  const afterAdjustment =
    afterCoin === null
      ? null
      : checkedAdd(afterCoin, adjustments.adjustment.value);
  return afterAdjustment === null
    ? null
    : checkedAdd(afterAdjustment, adjustments.codFee.value);
}

function deriveFormulaRelations(
  order: UnknownRecord,
  activePaths: Record<AmountPathKey, AggregatePathAmount>,
  shipping: Record<ShippingCandidateKey, FieldAmount>,
  adjustments: {
    discount: AdjustmentAmount;
    coinDiscount: AdjustmentAmount;
    adjustment: AdjustmentAmount;
    codFee: AdjustmentAmount;
  }
): Record<FormulaRelationKey, FormulaRelation> {
  const orderTotal = readIntegerField(order, "total");
  const orderTotalValue = orderTotal.state === "present" ? orderTotal.value : null;
  const adjustmentPresences = Object.values(adjustments).map(
    (item) => item.presence
  );
  const relations = {} as Record<FormulaRelationKey, FormulaRelation>;
  for (const amountPath of AMOUNT_PATH_KEYS) {
    for (const shippingCandidate of SHIPPING_CANDIDATE_KEYS) {
      const key = `${amountPath}__${shippingCandidate}` as FormulaRelationKey;
      const path = activePaths[amountPath];
      const shippingAmount = shipping[shippingCandidate];
      if (orderTotalValue === null || path.presence === "invalid") {
        relations[key] = "invalid";
      } else if (path.presence !== "all_present" || path.value === null) {
        relations[key] = "unavailable";
      } else if (adjustmentPresences.includes("invalid")) {
        relations[key] = "invalid";
      } else if (adjustmentPresences.includes("absent")) {
        relations[key] = "unavailable";
      } else if (shippingAmount.state === "invalid") {
        relations[key] = "invalid";
      } else if (shippingAmount.state !== "present") {
        relations[key] = "unavailable";
      } else {
        const adjusted = applyDocumentedAdjustments(path.value, adjustments);
        const candidate =
          adjusted === null ? null : checkedAdd(adjusted, shippingAmount.value);
        relations[key] =
          candidate === null
            ? "invalid"
            : candidate === orderTotalValue
              ? "matches"
              : "does_not_match";
      }
    }
  }
  return relations;
}

function deriveCancellationConsistency(
  topLevelCancelled: "null" | "value" | "missing",
  candidate: CancellationCandidate
): CancellationConsistency {
  if (topLevelCancelled === "missing" || candidate === "indeterminate") {
    return "indeterminate";
  }
  if (candidate === "full_cancel") {
    return topLevelCancelled === "value" ? "consistent" : "conflict";
  }
  return topLevelCancelled === "null" ? "consistent" : "conflict";
}

function emptyFormulaRelations(value: FormulaRelation): Record<FormulaRelationKey, FormulaRelation> {
  return Object.fromEntries(FORMULA_RELATION_KEYS.map((key) => [key, value])) as Record<
    FormulaRelationKey,
    FormulaRelation
  >;
}

function makeIndeterminateDiagnostic(): PartialCancelDiagnostic {
  const emptyPresence = {
    item_total_field: "invalid",
    item_plus_option_total: "invalid",
    price_plus_options_reconstructed: "invalid",
  } as const;
  return {
    schemaVersion: PARTIAL_CANCEL_DIAGNOSTIC_SCHEMA_VERSION,
    outcome: "stop_indeterminate",
    topLevelCancelled: "missing",
    knownItemStatuses: {
      ordered: "absent",
      cancelled: "absent",
      dispatched: "absent",
    },
    unknownItemStatus: "present",
    cancellationCandidate: "indeterminate",
    cancellationConsistency: "indeterminate",
    cancelledItemsRemainInOrderItems: "indeterminate",
    amountPathPresence: { active: emptyPresence, cancelled: emptyPresence },
    amountPathAgreement: {
      active: "no_complete_path",
      cancelled: "no_complete_path",
    },
    taxRateComposition: { active: "indeterminate", cancelled: "indeterminate" },
    shippingLineItemScope: "unresolvable_or_invalid",
    adjustmentPresence: {
      discount: "invalid",
      coinDiscount: "invalid",
      adjustment: "invalid",
      codFee: "invalid",
    },
    formulaRelations: emptyFormulaRelations("invalid"),
  };
}

function groupPathsAreUsable(
  paths: Record<AmountPathKey, AggregatePathAmount>,
  itemCount: number
): boolean {
  if (itemCount === 0) return true;
  const presences = AMOUNT_PATH_KEYS.map((key) => paths[key].presence);
  return (
    presences.includes("all_present") &&
    !presences.includes("partially_present") &&
    !presences.includes("invalid")
  );
}

export function analyzePartialCancellationV2(rawOrder: unknown): PartialCancelDiagnostic {
  const order = asRecord(rawOrder);
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) {
    return makeIndeterminateDiagnostic();
  }
  const items = order.order_items.map(asRecord);
  if (items.some((item) => item === null)) return makeIndeterminateDiagnostic();
  const validItems = items as UnknownRecord[];
  const statuses = validItems.map((item) =>
    typeof item.status === "string" ? item.status : ""
  );
  const unknownItemStatus = statuses.some(
    (status) => !KNOWN_ITEM_STATUSES.has(status as never)
  )
    ? "present"
    : "absent";
  const activeItems = validItems.filter(
    (_, index) => statuses[index] === "ordered" || statuses[index] === "dispatched"
  );
  const cancelledItems = validItems.filter((_, index) => statuses[index] === "cancelled");

  let cancellationCandidate: CancellationCandidate = "indeterminate";
  if (unknownItemStatus === "absent") {
    if (activeItems.length > 0 && cancelledItems.length > 0) {
      cancellationCandidate = "partial_cancel";
    } else if (cancelledItems.length > 0) {
      cancellationCandidate = "full_cancel";
    } else {
      cancellationCandidate = "normal";
    }
  }

  const topLevelCancelled = !hasOwn(order, "cancelled")
    ? "missing"
    : order.cancelled === null
      ? "null"
      : "value";
  const cancellationConsistency = deriveCancellationConsistency(
    topLevelCancelled,
    cancellationCandidate
  );
  const activePaths = derivePathSet(activeItems);
  const cancelledPaths = derivePathSet(cancelledItems);
  const activeAgreement = derivePathAgreement(activePaths);
  const cancelledAgreement = derivePathAgreement(cancelledPaths);
  const shippingLines = deriveShippingLines(order, validItems, statuses);
  const adjustments = {
    discount: deriveNestedAdjustment(order, "order_discount", "discount"),
    coinDiscount: deriveNestedAdjustment(order, "order_header_coin", "discount"),
    adjustment: deriveNestedAdjustment(
      order,
      "order_amount_adjustment",
      "adjusted_amount",
      true
    ),
    codFee: deriveTopLevelAdjustment(order, "cod_fee"),
  };
  const shippingCandidates: Record<ShippingCandidateKey, FieldAmount> = {
    without_shipping: { state: "present", value: 0 },
    order_shipping_fee: readIntegerField(order, "shipping_fee"),
    all_shipping_lines: shippingLines.allLines,
    active_shipping_lines_only: shippingLines.activeLines,
    active_item_shipping_fee: deriveActiveItemShipping(activeItems),
  };
  const formulaRelations = deriveFormulaRelations(
    order,
    activePaths,
    shippingCandidates,
    adjustments
  );
  const activeTax = deriveTaxRateComposition(activeItems);
  const cancelledTax = deriveTaxRateComposition(cancelledItems);
  const pathConflict =
    activeAgreement === "available_paths_conflict" ||
    cancelledAgreement === "available_paths_conflict";
  const taxIndeterminate = [activeTax, cancelledTax].some(
    (composition) =>
      composition === "unknown_rate_present" || composition === "indeterminate"
  );
  const adjustmentsComplete = Object.values(adjustments).every(
    (item) => item.presence === "present"
  );
  const hasMatchingFormula = Object.values(formulaRelations).includes("matches");
  const enumComplete =
    unknownItemStatus === "absent" &&
    cancellationCandidate !== "indeterminate" &&
    cancellationConsistency === "consistent" &&
    groupPathsAreUsable(activePaths, activeItems.length) &&
    groupPathsAreUsable(cancelledPaths, cancelledItems.length) &&
    !pathConflict &&
    !taxIndeterminate &&
    shippingLines.scope !== "unresolvable_or_invalid" &&
    adjustmentsComplete &&
    hasMatchingFormula;

  return {
    schemaVersion: PARTIAL_CANCEL_DIAGNOSTIC_SCHEMA_VERSION,
    outcome: enumComplete ? "pass_enum_complete" : "stop_indeterminate",
    topLevelCancelled,
    knownItemStatuses: {
      ordered: statuses.includes("ordered") ? "present" : "absent",
      cancelled: statuses.includes("cancelled") ? "present" : "absent",
      dispatched: statuses.includes("dispatched") ? "present" : "absent",
    },
    unknownItemStatus,
    cancellationCandidate,
    cancellationConsistency,
    cancelledItemsRemainInOrderItems:
      unknownItemStatus === "present"
        ? "indeterminate"
        : cancelledItems.length > 0
          ? "yes"
          : "no",
    amountPathPresence: {
      active: Object.fromEntries(
        AMOUNT_PATH_KEYS.map((key) => [key, activePaths[key].presence])
      ) as Record<AmountPathKey, AmountPathPresence>,
      cancelled: Object.fromEntries(
        AMOUNT_PATH_KEYS.map((key) => [key, cancelledPaths[key].presence])
      ) as Record<AmountPathKey, AmountPathPresence>,
    },
    amountPathAgreement: { active: activeAgreement, cancelled: cancelledAgreement },
    taxRateComposition: { active: activeTax, cancelled: cancelledTax },
    shippingLineItemScope: shippingLines.scope,
    adjustmentPresence: {
      discount: adjustments.discount.presence,
      coinDiscount: adjustments.coinDiscount.presence,
      adjustment: adjustments.adjustment.presence,
      codFee: adjustments.codFee.presence,
    },
    formulaRelations,
  };
}

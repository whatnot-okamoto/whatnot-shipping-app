import {
  AMOUNT_PATH_KEYS,
  FORMULA_RELATION_KEYS,
  PARTIAL_CANCEL_DIAGNOSTIC_SCHEMA_VERSION,
  type PartialCancelDiagnostic,
} from "./partial-cancel-diagnostic-v2";

type UnknownRecord = Record<string, unknown>;

const PRESENCE = new Set(["present", "absent"]);
const OUTCOME = new Set(["pass_enum_complete", "stop_indeterminate"]);
const TOP_LEVEL_CANCELLED = new Set(["null", "value", "missing"]);
const UNKNOWN_ITEM_STATUS = new Set(["absent", "present"]);
const CANCELLED_ITEMS_REMAIN = new Set(["yes", "no", "indeterminate"]);
const AMOUNT_PATH_PRESENCE = new Set([
  "all_present",
  "partially_present",
  "not_present",
  "invalid",
]);
const AMOUNT_PATH_AGREEMENT = new Set([
  "all_available_paths_agree",
  "available_paths_conflict",
  "single_path_only",
  "no_complete_path",
]);
const CANCELLATION_CANDIDATE = new Set([
  "normal",
  "partial_cancel",
  "full_cancel",
  "indeterminate",
]);
const CANCELLATION_CONSISTENCY = new Set([
  "consistent",
  "conflict",
  "indeterminate",
]);
const TAX_RATE_COMPOSITION = new Set([
  "none",
  "rate_8_only",
  "rate_10_only",
  "mixed_8_10",
  "unknown_rate_present",
  "indeterminate",
]);
const SHIPPING_LINE_ITEM_SCOPE = new Set([
  "no_shipping_lines",
  "active_items_only",
  "cancelled_items_only",
  "active_and_cancelled_items",
  "unresolvable_or_invalid",
]);
const OPTIONAL_AMOUNT_PRESENCE = new Set(["absent", "present", "invalid"]);
const FORMULA_RELATION = new Set([
  "matches",
  "does_not_match",
  "unavailable",
  "invalid",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasAllowedValues(
  value: unknown,
  keys: readonly string[],
  allowed: ReadonlySet<string>
): boolean {
  if (!isRecord(value)) return false;
  return keys.every((key) => typeof value[key] === "string" && allowed.has(value[key]));
}

function isAllowed(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === "string" && allowed.has(value);
}

export function readSafePartialCancelDiagnostic(
  value: unknown
): PartialCancelDiagnostic | null {
  if (!isRecord(value) || !isRecord(value.diagnostic)) return null;
  const diagnostic = value.diagnostic;

  if (diagnostic.schemaVersion !== PARTIAL_CANCEL_DIAGNOSTIC_SCHEMA_VERSION) return null;
  if (!isAllowed(diagnostic.outcome, OUTCOME)) return null;
  if (!isAllowed(diagnostic.topLevelCancelled, TOP_LEVEL_CANCELLED)) return null;
  if (!hasAllowedValues(diagnostic.knownItemStatuses, ["ordered", "cancelled", "dispatched"], PRESENCE)) return null;
  if (!isAllowed(diagnostic.unknownItemStatus, UNKNOWN_ITEM_STATUS)) return null;
  if (!isAllowed(diagnostic.cancellationCandidate, CANCELLATION_CANDIDATE)) return null;
  if (!isAllowed(diagnostic.cancellationConsistency, CANCELLATION_CONSISTENCY)) return null;
  if (!isAllowed(diagnostic.cancelledItemsRemainInOrderItems, CANCELLED_ITEMS_REMAIN)) return null;

  if (!isRecord(diagnostic.amountPathPresence)) return null;
  if (!hasAllowedValues(diagnostic.amountPathPresence.active, AMOUNT_PATH_KEYS, AMOUNT_PATH_PRESENCE)) return null;
  if (!hasAllowedValues(diagnostic.amountPathPresence.cancelled, AMOUNT_PATH_KEYS, AMOUNT_PATH_PRESENCE)) return null;

  if (!isRecord(diagnostic.amountPathAgreement)) return null;
  if (!isAllowed(diagnostic.amountPathAgreement.active, AMOUNT_PATH_AGREEMENT)) return null;
  if (!isAllowed(diagnostic.amountPathAgreement.cancelled, AMOUNT_PATH_AGREEMENT)) return null;

  if (!isRecord(diagnostic.taxRateComposition)) return null;
  if (!isAllowed(diagnostic.taxRateComposition.active, TAX_RATE_COMPOSITION)) return null;
  if (!isAllowed(diagnostic.taxRateComposition.cancelled, TAX_RATE_COMPOSITION)) return null;
  if (!isAllowed(diagnostic.shippingLineItemScope, SHIPPING_LINE_ITEM_SCOPE)) return null;

  if (!hasAllowedValues(
    diagnostic.adjustmentPresence,
    ["discount", "coinDiscount", "adjustment", "codFee"],
    OPTIONAL_AMOUNT_PRESENCE
  )) return null;
  if (!hasAllowedValues(diagnostic.formulaRelations, FORMULA_RELATION_KEYS, FORMULA_RELATION)) return null;

  const amountPathPresence = diagnostic.amountPathPresence as UnknownRecord;
  const activePresence = amountPathPresence.active as UnknownRecord;
  const cancelledPresence = amountPathPresence.cancelled as UnknownRecord;
  const amountPathAgreement = diagnostic.amountPathAgreement as UnknownRecord;
  const taxRateComposition = diagnostic.taxRateComposition as UnknownRecord;
  const knownItemStatuses = diagnostic.knownItemStatuses as UnknownRecord;
  const adjustmentPresence = diagnostic.adjustmentPresence as UnknownRecord;
  const formulaRelations = diagnostic.formulaRelations as UnknownRecord;

  return {
    schemaVersion: PARTIAL_CANCEL_DIAGNOSTIC_SCHEMA_VERSION,
    outcome: diagnostic.outcome,
    topLevelCancelled: diagnostic.topLevelCancelled,
    knownItemStatuses: {
      ordered: knownItemStatuses.ordered,
      cancelled: knownItemStatuses.cancelled,
      dispatched: knownItemStatuses.dispatched,
    },
    unknownItemStatus: diagnostic.unknownItemStatus,
    cancellationCandidate: diagnostic.cancellationCandidate,
    cancellationConsistency: diagnostic.cancellationConsistency,
    cancelledItemsRemainInOrderItems: diagnostic.cancelledItemsRemainInOrderItems,
    amountPathPresence: {
      active: Object.fromEntries(
        AMOUNT_PATH_KEYS.map((key) => [key, activePresence[key]])
      ),
      cancelled: Object.fromEntries(
        AMOUNT_PATH_KEYS.map((key) => [key, cancelledPresence[key]])
      ),
    },
    amountPathAgreement: {
      active: amountPathAgreement.active,
      cancelled: amountPathAgreement.cancelled,
    },
    taxRateComposition: {
      active: taxRateComposition.active,
      cancelled: taxRateComposition.cancelled,
    },
    shippingLineItemScope: diagnostic.shippingLineItemScope,
    adjustmentPresence: {
      discount: adjustmentPresence.discount,
      coinDiscount: adjustmentPresence.coinDiscount,
      adjustment: adjustmentPresence.adjustment,
      codFee: adjustmentPresence.codFee,
    },
    formulaRelations: Object.fromEntries(
      FORMULA_RELATION_KEYS.map((key) => [key, formulaRelations[key]])
    ),
  } as PartialCancelDiagnostic;
}

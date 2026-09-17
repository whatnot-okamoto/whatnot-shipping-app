import type { BaseOrderSummary } from "@/lib/base-api";

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isBaseOrderSummary(value: unknown): value is BaseOrderSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.unique_key === "string" &&
    summary.unique_key.length > 0 &&
    isFiniteNumber(summary.ordered) &&
    isNullableNumber(summary.cancelled) &&
    isNullableNumber(summary.dispatched) &&
    typeof summary.payment === "string" &&
    typeof summary.first_name === "string" &&
    typeof summary.last_name === "string" &&
    isFiniteNumber(summary.total) &&
    isNullableString(summary.delivery_date) &&
    isNullableString(summary.delivery_time_zone) &&
    typeof summary.terminated === "boolean" &&
    typeof summary.dispatch_status === "string" &&
    isFiniteNumber(summary.modified)
  );
}

export function isBaseOrderSummaryList(
  value: unknown
): value is BaseOrderSummary[] {
  return Array.isArray(value) && value.every(isBaseOrderSummary);
}

import type { OrderSnapshot } from "./order-store";
import type { RefetchState } from "./refetch-store";
import type { GenerationIssueCode } from "./pdf-order-assessment";
import { workflowFingerprint } from "./order-snapshot-diff";

export type SelectionVerificationFailure = {
  unique_key: string;
  reason:
    | "not_verified_in_current_cycle"
    | "fetch_failed"
    | "not_in_open_orders"
    | "blocked";
  issues: GenerationIssueCode[];
};

export function findSelectionVerificationFailures(
  refetchState: RefetchState | null,
  snapshots: Map<string, OrderSnapshot>,
  expandedUniqueKeys: string[]
): SelectionVerificationFailure[] {
  const cycleId = refetchState?.refetch_cycle_id;
  const results = refetchState?.order_results ?? {};
  const failures: SelectionVerificationFailure[] = [];
  for (const uniqueKey of expandedUniqueKeys) {
    const result = results[uniqueKey];
    const snapshot = snapshots.get(uniqueKey);
    if (!cycleId || !result || !refetchState?.workflow_epoch ||
        !refetchState.current_order_keys?.includes(uniqueKey) ||
        result.status === 'unprocessed') {
      failures.push({
        unique_key: uniqueKey,
        reason: "not_verified_in_current_cycle",
        issues: [],
      });
      continue;
    }
    if (result.status === "fetch_failed") {
      failures.push({
        unique_key: uniqueKey,
        reason: "fetch_failed",
        issues: result.issues,
      });
      continue;
    }
    if (
      result.status === "not_in_open_orders" ||
      snapshot?.open_order_presence === "not_in_open_orders"
    ) {
      failures.push({
        unique_key: uniqueKey,
        reason: "not_in_open_orders",
        issues: ["not_in_open_orders"],
      });
      continue;
    }
    if (snapshot?.pdf_verification_cycle_id !== cycleId || snapshot?.workflow_epoch !== refetchState.workflow_epoch ||
        workflowFingerprint(snapshot) !== refetchState.confirmation_manifest?.[uniqueKey]) {
      failures.push({
        unique_key: uniqueKey,
        reason: "not_verified_in_current_cycle",
        issues: [],
      });
      continue;
    }
    if (
      result.status === "verified_blocked" || refetchState.held_bundle_order_keys?.includes(uniqueKey) ||
      snapshot.pdf_generation_outcome !== "eligible"
    ) {
      failures.push({
        unique_key: uniqueKey,
        reason: "blocked",
        issues: result.issues,
      });
    }
  }
  return failures;
}

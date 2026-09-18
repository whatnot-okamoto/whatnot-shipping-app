import type { OrderSnapshot } from "./order-store";
import type { RefetchState } from "./refetch-store";
import type { GenerationIssueCode } from "./pdf-order-assessment";
import { workflowFingerprint } from "./order-snapshot-diff";
import type { U2Data } from './order-store';

export function isValidBundleMembership(value: unknown, id: string): value is U2Data {
  if (!value || typeof value!=='object') return false;
  const v=value as U2Data;
  return v.bundle_group_id===id && Array.isArray(v.order_unique_keys) && v.order_unique_keys.length>0 &&
    v.order_unique_keys.length<=100 && new Set(v.order_unique_keys).size===v.order_unique_keys.length &&
    v.order_unique_keys.every(k=>typeof k==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(k)) &&
    v.order_unique_keys.includes(v.representative_order_unique_key) && typeof v.bundle_enabled==='boolean' &&
    typeof v.tracking_number==='string';
}

export function bundleMatchesSnapshots(id: string, bundle: unknown, snapshots: Map<string, OrderSnapshot>): bundle is U2Data {
  return isValidBundleMembership(bundle,id) && bundle.order_unique_keys.every(key=>
    snapshots.get(key)?.unique_key===key && snapshots.get(key)?.bundle_group_id===id);
}

/** Only known CURRENT members are held. Invalid stored membership is never reconstructed. */
export function findHeldCurrentBundleOrders(ids: string[], previous: Map<string,OrderSnapshot>,
  candidates: Map<string,OrderSnapshot>, bundles: Map<string,U2Data>, results: RefetchState['order_results'],
  existingOrderIds: Set<string>): Set<string> {
  const current=new Set(ids), badGroups=new Set<string>(), held=new Set<string>();
  const validSnapshot=(s:OrderSnapshot|undefined,id:string) => !!s && s.unique_key===id &&
    typeof s.bundle_group_id==='string' && /^bg_[a-f0-9]{32}$/.test(s.bundle_group_id);
  for(const id of ids) {
    const old=previous.get(id), next=candidates.get(id);
    if ((old && !validSnapshot(old,id)) || (!old && existingOrderIds.has(id))) {
      held.add(id); if(next) badGroups.add(next.bundle_group_id); continue;
    }
    if(old && next && old.bundle_group_id!==next.bundle_group_id) {
      badGroups.add(old.bundle_group_id); badGroups.add(next.bundle_group_id);
    }
    if(old) {
      const b=bundles.get(old.bundle_group_id);
      if(!isValidBundleMembership(b,old.bundle_group_id) || !b.order_unique_keys.includes(id)) badGroups.add(old.bundle_group_id);
    }
  }
  for(const [group,bundle] of bundles) {
    if(!isValidBundleMembership(bundle,group)) { badGroups.add(group); continue; }
    if(bundle.order_unique_keys.some(id=>!current.has(id) || results?.[id]?.status!=='verified_eligible' ||
      !validSnapshot(candidates.get(id),id) || candidates.get(id)?.bundle_group_id!==group)) badGroups.add(group);
  }
  for(const [id,next] of candidates) {
    if(results?.[id]?.status!=='verified_eligible') badGroups.add(next.bundle_group_id);
    const b=bundles.get(next.bundle_group_id);
    if(b && (!isValidBundleMembership(b,next.bundle_group_id) || (previous.has(id) && !b.order_unique_keys.includes(id))))
      badGroups.add(next.bundle_group_id);
  }
  // Propagate through known membership/old/new references until stable, bounded by current IDs/groups.
  let changed=true;
  while(changed) {
    const before=held.size+badGroups.size;
    for(const [group,b] of bundles) if(isValidBundleMembership(b,group)) {
      if(b.order_unique_keys.some(id=>held.has(id))) badGroups.add(group);
      if(badGroups.has(group)) for(const id of b.order_unique_keys) if(current.has(id)) held.add(id);
    }
    for(const id of ids) {
      const groups=[previous.get(id)?.bundle_group_id,candidates.get(id)?.bundle_group_id].filter((g):g is string=>typeof g==='string');
      if(groups.some(g=>badGroups.has(g))) held.add(id);
      if(held.has(id)) for(const g of groups) badGroups.add(g);
    }
    changed=before!==held.size+badGroups.size;
  }
  return held;
}

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

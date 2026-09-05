import type { OrderSnapshot } from "./order-store";
import { isValidOrderedTimestamp } from "./order-list-ordering";

export type StaffReviewSnapshotChanges = {
  itemChanged: boolean;
  feeChanged: boolean;
  shippingChanged: boolean;
};

/** スタッフ向け差分モーダルへ出す既存5項目だけを判定する。 */
export function getStaffReviewSnapshotChanges(
  existing: OrderSnapshot,
  pending: OrderSnapshot
): StaffReviewSnapshotChanges {
  return {
    itemChanged:
      existing.item_count !== pending.item_count ||
      existing.items_summary !== pending.items_summary,
    feeChanged: existing.shipping_fee !== pending.shipping_fee,
    shippingChanged:
      existing.shipping_method_name !== pending.shipping_method_name ||
      existing.shipping_lines_count !== pending.shipping_lines_count,
  };
}

export function hasStaffReviewSnapshotDiff(
  existing: OrderSnapshot,
  pending: OrderSnapshot
): boolean {
  const changes = getStaffReviewSnapshotChanges(existing, pending);
  return changes.itemChanged || changes.feeChanged || changes.shippingChanged;
}

/**
 * ordered_timestampの欠損・不正値・BASE値との不一致を補完対象にする。
 * pending側に正確な時刻がない場合は既存snapshotを変更しない。
 */
export function needsOrderedTimestampRepair(
  existing: OrderSnapshot,
  pending: OrderSnapshot
): boolean {
  return (
    isValidOrderedTimestamp(pending.ordered_timestamp) &&
    existing.ordered_timestamp !== pending.ordered_timestamp
  );
}

/** 差分確認完了時にsnapshotを昇格すべきかを判定する。 */
export function shouldPromotePendingSnapshot(
  existing: OrderSnapshot,
  pending: OrderSnapshot
): boolean {
  return (
    hasStaffReviewSnapshotDiff(existing, pending) ||
    needsOrderedTimestampRepair(existing, pending)
  );
}

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

/**
 * 差分確認完了時に保存するsnapshotを組み立てる。
 * pendingの時刻が無効なら既存の正常値を維持し、既存値も無効なら時刻自体を保存しない。
 */
export function buildPromotedOrderSnapshot(
  existing: OrderSnapshot,
  pending: OrderSnapshot
): OrderSnapshot | null {
  if (!shouldPromotePendingSnapshot(existing, pending)) return null;

  if (isValidOrderedTimestamp(pending.ordered_timestamp)) {
    return pending;
  }

  if (isValidOrderedTimestamp(existing.ordered_timestamp)) {
    return {
      ...pending,
      ordered_timestamp: existing.ordered_timestamp,
    };
  }

  const promoted = { ...pending };
  delete promoted.ordered_timestamp;
  return promoted;
}

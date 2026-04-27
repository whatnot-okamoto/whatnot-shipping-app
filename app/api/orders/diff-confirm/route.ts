// POST /api/orders/diff-confirm
// pending snapshotを確認・昇格し、diff_confirmed_flagをONにする。
// has_new_uninitialized=trueの場合は拒否する（Section 0 絶対禁止事項）。

import { redis } from "@/lib/upstash";
import {
  getOrderSnapshotPending,
  getOrderSnapshot,
  deleteOrderSnapshotPending,
  getAllPendingUniqueKeys,
  type OrderSnapshot,
} from "@/lib/order-store";
import { getRefetchState, setRefetchState } from "@/lib/refetch-store";

/** 5フィールドを比較して差分があるか判定する（refetch側と同じ基準） */
function hasDiff(existing: OrderSnapshot, pending: OrderSnapshot): boolean {
  return (
    existing.shipping_fee !== pending.shipping_fee ||
    existing.shipping_method_name !== pending.shipping_method_name ||
    existing.shipping_lines_count !== pending.shipping_lines_count ||
    existing.item_count !== pending.item_count ||
    existing.items_summary !== pending.items_summary
  );
}

export async function POST() {
  try {
    // 手順1: refetch_state確認
    const refetchState = await getRefetchState();

    if (!refetchState || refetchState.refetch_done_flag !== true) {
      return Response.json(
        { success: false, error: "再取得が完了していません。先に再取得を実行してください" },
        { status: 400 }
      );
    }

    if (refetchState.has_new_uninitialized === true) {
      return Response.json(
        {
          success: false,
          error: "未初期化注文があります。初期化を実行してから再取得してください",
        },
        { status: 409 }
      );
    }

    // 手順2: pending対象unique_key全件取得
    const pendingKeys = await getAllPendingUniqueKeys();

    // 手順3: 差分ありpendingはsnapshotへ昇格、差分なしpendingは削除のみ
    for (const uniqueKey of pendingKeys) {
      const [existing, pending] = await Promise.all([
        getOrderSnapshot(uniqueKey),
        getOrderSnapshotPending(uniqueKey),
      ]);

      if (!pending) {
        // pending消失（稀）: Setのみクリーンアップ
        await redis.srem("index:order_snapshot_pending", uniqueKey);
        continue;
      }

      if (existing && hasDiff(existing, pending)) {
        // 差分あり → order_snapshot:{unique_key} に昇格（上書き）
        // Section 0: 差分確認完了後のみ order_snapshot を上書き可
        await redis.set(`order_snapshot:${uniqueKey}`, JSON.stringify(pending));
      }
      // 差分なし・またはexisting未存在 → snapshotは変更しない

      await deleteOrderSnapshotPending(uniqueKey);
    }

    // 手順4: diff_confirmed_flagをtrueに更新
    await setRefetchState({
      ...refetchState,
      diff_confirmed_flag: true,
    });

    return Response.json({ success: true, diff_confirmed_flag: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

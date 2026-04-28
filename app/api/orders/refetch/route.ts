// POST /api/orders/refetch
// BASE APIから最新の注文情報を取得し、order_snapshot_pendingを生成して差分を判定する。
// U1・U2・U4・order_snapshot は更新しない（DATA-01 T1原則）。

import { redis } from "@/lib/upstash";
import { fetchOrderedOrders, fetchOrderDetail } from "@/lib/base-api";
import {
  getOrderSnapshot,
  buildOrderSnapshotFromDetail,
  setOrderSnapshotPending,
  deleteAllOrderSnapshotPending,
  type OrderSnapshot,
} from "@/lib/order-store";
import { resetRefetchState, setRefetchState } from "@/lib/refetch-store";
import { requireAuth } from "@/lib/auth";

export type DiffItem = {
  unique_key: string;
  diff_type: "item_changed" | "cancelled" | "fee_changed" | "new_order" | "disappeared" | "other";
  description: string;
  severity: "info" | "warning" | "blocking";
};

/** 5フィールドを比較してDiffItemを生成する。差分なしの場合はnullを返す */
function comparePendingToSnapshot(
  uniqueKey: string,
  existing: OrderSnapshot,
  pending: OrderSnapshot
): DiffItem | null {
  const itemChanged =
    existing.item_count !== pending.item_count ||
    existing.items_summary !== pending.items_summary;
  const feeChanged = existing.shipping_fee !== pending.shipping_fee;
  const shippingChanged =
    existing.shipping_method_name !== pending.shipping_method_name ||
    existing.shipping_lines_count !== pending.shipping_lines_count;

  if (!itemChanged && !feeChanged && !shippingChanged) return null;

  if (itemChanged) {
    return {
      unique_key: uniqueKey,
      diff_type: "item_changed",
      description: "商品内容が変更されました",
      severity: "warning",
    };
  }
  if (feeChanged) {
    return {
      unique_key: uniqueKey,
      diff_type: "fee_changed",
      description: "送料が変更されました",
      severity: "info",
    };
  }
  return {
    unique_key: uniqueKey,
    diff_type: "other",
    description: "配送情報が変更されました",
    severity: "info",
  };
}

export async function POST(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  try {
    // 手順1: refetch_stateを初期化
    await resetRefetchState();

    // 手順2: 既存のpendingを全削除
    await deleteAllOrderSnapshotPending();

    // 手順3: BASE一覧取得 + 3条件フィルタ
    const baseOrders = await fetchOrderedOrders();
    const baseOpenOrders = baseOrders.filter(
      (o) =>
        o.dispatch_status === "ordered" &&
        o.dispatched === null &&
        o.terminated === false
    );
    const baseOpenKeys = new Set(baseOpenOrders.map((o) => o.unique_key));

    // 手順4: index:orders と照合して分類
    const indexKeys: string[] = await redis.smembers("index:orders");
    const indexKeySet = new Set(indexKeys);

    const disappeared: string[] = [];     // index:orders にあるがBASE未対応にない
    const newOrders: string[] = [];        // BASE未対応にあるがindex:ordersにない
    const intersectKeys: string[] = [];   // 両方にある → snapshot確認へ

    for (const key of indexKeys) {
      if (baseOpenKeys.has(key)) intersectKeys.push(key);
      else disappeared.push(key);
    }
    for (const key of baseOpenKeys) {
      if (!indexKeySet.has(key)) newOrders.push(key);
    }

    // 手順4続き: intersectKeysのsnapshotを一括確認
    const existingWithSnapshot: string[] = [];
    const noSnapshot: string[] = [];
    if (intersectKeys.length > 0) {
      const pipe = redis.pipeline();
      for (const key of intersectKeys) pipe.get(`order_snapshot:${key}`);
      const results = await pipe.exec();
      intersectKeys.forEach((key, i) => {
        if (results[i]) existingWithSnapshot.push(key);
        else noSnapshot.push(key);
      });
    }

    // 手順5・6: 既存+snapshotありの注文のみ詳細取得してpending生成・差分比較
    const diffSummary: DiffItem[] = [];
    const pendingSnapshots = new Map<string, OrderSnapshot>();

    for (const uniqueKey of existingWithSnapshot) {
      try {
        const [detail, existingSnap] = await Promise.all([
          fetchOrderDetail(uniqueKey),
          getOrderSnapshot(uniqueKey),
        ]);
        if (!existingSnap) continue; // 取得競合（稀）

        const pending = buildOrderSnapshotFromDetail(detail, existingSnap.bundle_group_id);
        await setOrderSnapshotPending(uniqueKey, pending);
        pendingSnapshots.set(uniqueKey, pending);

        const diffItem = comparePendingToSnapshot(uniqueKey, existingSnap, pending);
        if (diffItem) diffSummary.push(diffItem);
      } catch {
        // 詳細取得失敗は軽微扱い
        diffSummary.push({
          unique_key: uniqueKey,
          diff_type: "other",
          description: "再取得中にエラーが発生しました",
          severity: "info",
        });
      }
    }

    // 消えた注文をdiff_summaryに追加
    for (const key of disappeared) {
      diffSummary.push({
        unique_key: key,
        diff_type: "disappeared",
        description: "BASE未対応一覧から削除されました（出荷済み・キャンセルの可能性）",
        severity: "info",
      });
    }

    // 新規注文をdiff_summaryに追加
    for (const key of newOrders) {
      diffSummary.push({
        unique_key: key,
        diff_type: "new_order",
        description: "新規注文（未初期化）",
        severity: "warning",
      });
    }

    const hasNewUninitialized = newOrders.length > 0;

    // 手順7: refetch_stateを更新
    await setRefetchState({
      refetch_done_flag: true,
      diff_confirmed_flag: false,
      refetched_at: new Date().toISOString(),
      has_new_uninitialized: hasNewUninitialized,
    });

    // 手順8: レスポンス返却
    return Response.json({
      success: true,
      refetch_done_flag: true,
      diff_confirmed_flag: false,
      diff_result: {
        has_diff: diffSummary.length > 0,
        has_new_uninitialized: hasNewUninitialized,
        new_uninitialized_count: newOrders.length,
        diff_summary: diffSummary,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

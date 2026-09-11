// POST /api/orders/refetch
// BASE APIから最新の注文情報を取得し、order_snapshot_pendingを生成して差分を判定する。
// U1・U2・U4・order_snapshot は更新しない（DATA-01 T1原則）。

import { randomUUID } from "crypto";
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
import type { RefetchOrderResult } from "@/lib/refetch-store";
import { requireAuth } from "@/lib/auth";
import { getStaffReviewSnapshotChanges } from "@/lib/order-snapshot-diff";
import { assessOrderForPdf } from "@/lib/pdf-order-assessment";

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
  const { itemChanged, feeChanged, shippingChanged } =
    getStaffReviewSnapshotChanges(existing, pending);

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
    const refetchCycleId = randomUUID();
    await resetRefetchState(refetchCycleId);

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
    const orderResults: Record<string, RefetchOrderResult> = {};
    const failedUniqueKeys: string[] = [];

    for (const uniqueKey of existingWithSnapshot) {
      try {
        const [detail, existingSnap] = await Promise.all([
          fetchOrderDetail(uniqueKey),
          getOrderSnapshot(uniqueKey),
        ]);
        if (!existingSnap) continue; // 取得競合（稀）

        const assessment = assessOrderForPdf(detail);
        const pending = buildOrderSnapshotFromDetail(
          detail,
          existingSnap.bundle_group_id,
          refetchCycleId
        );
        await setOrderSnapshotPending(uniqueKey, pending);
        orderResults[uniqueKey] = {
          status:
            assessment.generationOutcome === "eligible"
              ? "verified_eligible"
              : "verified_blocked",
          cancellation_state: assessment.cancellationState,
          issues: assessment.issues,
        };

        const diffItem = comparePendingToSnapshot(uniqueKey, existingSnap, pending);
        if (diffItem) diffSummary.push(diffItem);
      } catch {
        failedUniqueKeys.push(uniqueKey);
        orderResults[uniqueKey] = {
          status: "fetch_failed",
          issues: [],
        };
        diffSummary.push({
          unique_key: uniqueKey,
          diff_type: "other",
          description: "注文詳細を取得できませんでした。この注文は今回の選択対象から外れます",
          severity: "warning",
        });
      }
    }

    // 消えた注文をdiff_summaryに追加
    for (const key of disappeared) {
      const existingSnapshot = await getOrderSnapshot(key);
      if (existingSnapshot) {
        const pending: OrderSnapshot = {
          ...existingSnapshot,
          pdf_verification_cycle_id: refetchCycleId,
          open_order_presence: "not_in_open_orders",
          pdf_generation_outcome: "blocked",
          pdf_issue_codes: ["not_in_open_orders"],
        };
        await setOrderSnapshotPending(key, pending);
      }
      orderResults[key] = {
        status: "not_in_open_orders",
        issues: ["not_in_open_orders"],
      };
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
      refetch_cycle_id: refetchCycleId,
      refetch_result: failedUniqueKeys.length > 0 ? "partial" : "complete",
      order_results: orderResults,
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
        has_fetch_failures: failedUniqueKeys.length > 0,
        failed_unique_keys: failedUniqueKeys,
        diff_summary: diffSummary,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

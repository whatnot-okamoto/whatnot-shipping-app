// POST /api/orders/init
// BASE API から注文一覧を取得し、詳細を逐次フェッチして U1・U2・U4 を Upstash に初期化する。
//
// base-api.ts と order-store.ts は直接連携しない。
// このRoute Handler が橋渡しする（責務の分離）。

import { fetchOrderedOrders, fetchOrderDetail } from "@/lib/base-api";
import { initializeOrderData } from "@/lib/order-store";
import type { BaseOrder } from "@/lib/base-api";

export async function POST() {
  try {
    // 手順1: 注文一覧取得（サマリのみ）
    const summaries = await fetchOrderedOrders();

    // 手順2: 各 unique_key の詳細をシリアルフェッチ
    const details: BaseOrder[] = [];
    const failedUniqueKeys: string[] = [];
    const warnings: string[] = [];

    for (const summary of summaries) {
      try {
        const detail = await fetchOrderDetail(summary.unique_key);

        // shipping_lines チェック（0件 or 複数件はスタッフ確認が必要）
        if (detail.shipping_lines.length === 0) {
          warnings.push(
            `${summary.unique_key}: shipping_lines が 0 件（配送方法未設定）`
          );
        } else if (detail.shipping_lines.length > 1) {
          warnings.push(
            `${summary.unique_key}: shipping_lines が ${detail.shipping_lines.length} 件（複数配送）`
          );
        }

        details.push(detail);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failedUniqueKeys.push(summary.unique_key);
        warnings.push(`${summary.unique_key}: 詳細取得失敗 - ${msg}`);
      }
    }

    // 手順3: 詳細取得に成功した注文を Upstash に初期化
    const result = await initializeOrderData(details);

    // unknownMethodOrders を warnings に追記
    for (const unknown of result.unknownMethodOrders) {
      warnings.push(
        `${unknown.unique_key}: 配送方法マッピング未登録 [${unknown.detectedMethodNames.join(", ")}]`
      );
    }

    // index:orders sadd 失敗を warnings に追記（/api/orders/list の表示に影響するため明示）
    if (result.indexOrdersFailed) {
      warnings.push("index:orders への sadd が失敗しました。/api/orders/list に注文が表示されない可能性があります。");
    }

    const skipped = summaries.length - details.length;
    const hasIndexFailure = result.indexOrdersFailed;

    if (failedUniqueKeys.length === 0 && !hasIndexFailure) {
      return Response.json({
        success: true,
        status: "completed",
        initialized: result.u1Count,
        skipped,
        failed_unique_keys: [],
        warnings,
        u1Count: result.u1Count,
        u2Count: result.u2Count,
        u4Count: result.u4Count,
        snapshotCount: result.snapshotCount,
        indexOrdersAdded: result.indexOrdersAdded,
      });
    }

    return Response.json({
      success: false,
      status: "partial_failed",
      initialized: result.u1Count,
      skipped,
      failed_unique_keys: failedUniqueKeys,
      warnings,
      error: hasIndexFailure
        ? "index:orders への登録に失敗しました"
        : `${failedUniqueKeys.length} 件の詳細取得に失敗しました`,
      u1Count: result.u1Count,
      u2Count: result.u2Count,
      u4Count: result.u4Count,
      snapshotCount: result.snapshotCount,
      indexOrdersAdded: result.indexOrdersAdded,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json(
      { success: false, status: "failed", error: message },
      { status: 500 }
    );
  }
}

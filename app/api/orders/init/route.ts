// POST /api/orders/init
// BASE API から注文一覧を取得し、詳細を逐次フェッチして U1・U2・U4 を Upstash に初期化する。
//
// base-api.ts と order-store.ts は直接連携しない。
// このRoute Handler が橋渡しする（責務の分離）。

import { fetchOrderedOrders, fetchOrderDetail } from "@/lib/base-api";
import {
  getIncompleteOrderInitializationKeys,
  initializeOrderData,
} from "@/lib/order-store";
import type { BaseOrder } from "@/lib/base-api";
import { isBaseOrderSummaryList } from "@/lib/base-order-summary-validation";
import { requireAuth } from "@/lib/auth";
import { redis } from "@/lib/upstash";
import { getRefetchState, setRefetchStateFenced } from "@/lib/refetch-store";
import {
  acquireWorkflowLease,
  ORDERS_OPERATION_IN_PROGRESS_ERROR_CODE,
  releaseWorkflowLease,
  renewWorkflowLeaseIfDue,
  WorkflowLeaseLostError,
} from "@/lib/workflow-operation-lease";

export const maxDuration = 300;
export const INIT_BASE_LIST_TIMEOUT_MS = 30_000;
export const INIT_BASE_DETAIL_TIMEOUT_MS = 45_000;
export const INIT_BASE_PHASE_TIMEOUT_MS = 180_000;

async function withBaseOperationTimeout<T>(
  phaseSignal: AbortSignal,
  operationTimeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const operationSignal = AbortSignal.timeout(operationTimeoutMs);
  const signal = AbortSignal.any([phaseSignal, operationSignal]);
  return Promise.race([
    operation(signal),
    new Promise<T>((_, reject) => {
      const rejectForTimeout = () =>
        reject(new DOMException("BASE request timed out", "TimeoutError"));
      if (signal.aborted) {
        rejectForTimeout();
        return;
      }
      signal.addEventListener("abort", rejectForTimeout, { once: true });
    }),
  ]);
}

export async function POST(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  let requestedCycleId: string | null = null;
  try {
    const body = await req.clone().json();
    if (
      body &&
      typeof body === "object" &&
      "refetch_cycle_id" in body &&
      typeof (body as { refetch_cycle_id?: unknown }).refetch_cycle_id === "string"
    ) {
      requestedCycleId = (body as { refetch_cycle_id: string }).refetch_cycle_id;
    }
  } catch {
    // Initial bootstrap remains body-less; recovery init carries a cycle id.
  }

  const lease = await acquireWorkflowLease("init", requestedCycleId);
  if (!lease) {
    return Response.json(
      {
        success: false,
        error_code: ORDERS_OPERATION_IN_PROGRESS_ERROR_CODE,
        message: "別の更新処理が進行中です。",
      },
      { status: 409 }
    );
  }

  try {
    const [refetchState, indexedOrders, pendingKeys, currentSessionId] =
      await Promise.all([
        getRefetchState(),
        redis.smembers("index:orders"),
        redis.smembers("index:order_snapshot_pending"),
        redis.get<string>("session:current"),
      ]);
    const isInitialBootstrap =
      requestedCycleId === null &&
      refetchState === null &&
      indexedOrders.length === 0 &&
      pendingKeys.length === 0 &&
      currentSessionId === null;
    const isSameCycleRecoveryInit =
      refetchState?.has_new_uninitialized === true &&
      (refetchState.phase === "awaiting_initialization" ||
        refetchState.phase === undefined) &&
      requestedCycleId !== null &&
      requestedCycleId === refetchState.refetch_cycle_id &&
      currentSessionId === null;
    if (!isInitialBootstrap && !isSameCycleRecoveryInit) {
      return Response.json(
        {
          success: false,
          error_code: "init_not_allowed",
          message:
            "初期化できる状態ではありません。画面を再読み込みしてください。",
        },
        { status: 409 }
      );
    }
    // BASE読取りphaseはroute上限300秒より120秒早く閉じる。
    // 一覧・詳細1件にも個別上限を設け、複数の正常応答が単一の短い
    // signalを共有して誤って打ち切られないようにする。残り時間は、
    // 取得済み注文のRedis保存、lease付き状態更新、応答に確保する。
    const basePhaseSignal = AbortSignal.any([
      AbortSignal.timeout(INIT_BASE_PHASE_TIMEOUT_MS),
      req.signal,
    ]);

    // 手順1: 注文一覧取得（サマリのみ）
    const summariesResult: unknown = await withBaseOperationTimeout(
      basePhaseSignal,
      INIT_BASE_LIST_TIMEOUT_MS,
      (signal) => fetchOrderedOrders({ signal })
    );
    if (!isBaseOrderSummaryList(summariesResult)) {
      throw new Error("BASE order list response has an invalid shape");
    }
    const summaries = summariesResult.filter(
      (summary) =>
        summary.dispatch_status === "ordered" &&
        summary.dispatched === null &&
        summary.terminated === false
    );

    if (isSameCycleRecoveryInit && summaries.length === 0) {
      const unresolvedCount = refetchState?.new_uninitialized_count;
      if (!Number.isSafeInteger(unresolvedCount) || Number(unresolvedCount) <= 0) {
        return Response.json(
          {
            success: false,
            error_code: "uninitialized_count_unavailable",
            message:
              "前回の未初期化件数を確認できません。状態を変更せず停止しました。",
          },
          { status: 409 }
        );
      }
      const checkedAt = new Date().toISOString();
      await setRefetchStateFenced(lease, {
        ...refetchState,
        phase: "awaiting_initialization",
        diff_confirmed_flag: false,
        post_init_refetch_ready: true,
        empty_init_source_cycle_id: refetchState.refetch_cycle_id,
        empty_init_uninitialized_count: unresolvedCount,
        empty_init_checked_at: checkedAt,
      });
      return Response.json({
        success: true,
        status: "empty_current_orders",
        initialized: 0,
        skipped: 0,
        failed_unique_keys: [],
        warnings: [],
        u1Count: 0,
        u2Count: 0,
        u4Count: 0,
        snapshotCount: 0,
        indexOrdersAdded: 0,
      });
    }
    const indexedOrderSet = new Set(indexedOrders);
    const indexedCurrentKeys = summaries
      .map((summary) => summary.unique_key)
      .filter((uniqueKey) => indexedOrderSet.has(uniqueKey));
    const incompleteIndexedKeys = await getIncompleteOrderInitializationKeys(
      indexedCurrentKeys
    );
    await renewWorkflowLeaseIfDue(lease);
    const uninitializedSummaries = summaries.filter(
      (summary) =>
        !indexedOrderSet.has(summary.unique_key) ||
        incompleteIndexedKeys.has(summary.unique_key)
    );

    // 手順2: 未初期化unique_keyだけをシリアルフェッチ。
    // 部分成功後の同一cycle再開では、前回保存済み注文を再初期化しない。
    const details: BaseOrder[] = [];
    const failedUniqueKeys: string[] = [];
    const warnings: string[] = [];

    for (let index = 0; index < uninitializedSummaries.length; index += 1) {
      const summary = uninitializedSummaries[index];
      if (basePhaseSignal.aborted) {
        failedUniqueKeys.push(
          ...uninitializedSummaries.slice(index).map((item) => item.unique_key)
        );
        warnings.push("初期化全体のBASE取得時間上限に達しました。");
        break;
      }
      await renewWorkflowLeaseIfDue(lease);
      try {
        const detail = await withBaseOperationTimeout(
          basePhaseSignal,
          INIT_BASE_DETAIL_TIMEOUT_MS,
          (signal) => fetchOrderDetail(summary.unique_key, { signal })
        );

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
        if (basePhaseSignal.aborted) {
          failedUniqueKeys.push(
            ...uninitializedSummaries
              .slice(index + 1)
              .map((item) => item.unique_key)
          );
          warnings.push("初期化全体のBASE取得時間上限に達しました。");
          break;
        }
      }
    }

    // 手順3: 詳細取得に成功した注文を Upstash に初期化
    const result = await initializeOrderData(details, lease);

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

    const skipped = uninitializedSummaries.length - details.length;
    const hasIndexFailure = result.indexOrdersFailed;

    if (failedUniqueKeys.length === 0 && !hasIndexFailure) {
      if (refetchState?.has_new_uninitialized === true) {
        await setRefetchStateFenced(lease, {
          ...refetchState,
          post_init_refetch_ready: true,
          phase: "awaiting_initialization",
          diff_confirmed_flag: false,
        });
      }
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

    console.error("[orders/init] 初期化部分失敗:", {
      failedUniqueKeys,
      hasIndexFailure,
      warnings,
      result,
    });
    if (refetchState?.has_new_uninitialized === true) {
      const remainingUninitializedCount = hasIndexFailure
        ? uninitializedSummaries.length
        : failedUniqueKeys.length;
      await setRefetchStateFenced(lease, {
        ...refetchState,
        phase: "awaiting_initialization",
        diff_confirmed_flag: false,
        has_new_uninitialized: true,
        new_uninitialized_count: remainingUninitializedCount,
        post_init_refetch_ready: false,
      });
    }
    return Response.json({
      success: false,
      status: "partial_failed",
      initialized: result.u1Count,
      skipped,
      failed_unique_keys: failedUniqueKeys,
      warnings,
      message:
        "一部の注文を初期化できませんでした。同じ画面では再押下せず、画面を再読み込みして状態を確認してください。",
      u1Count: result.u1Count,
      u2Count: result.u2Count,
      u4Count: result.u4Count,
      snapshotCount: result.snapshotCount,
      indexOrdersAdded: result.indexOrdersAdded,
    });
  } catch (err) {
    if (err instanceof WorkflowLeaseLostError) {
      return Response.json(
        { success: false, message: "更新権限が失効しました。再読み込みしてください。" },
        { status: 409 }
      );
    }
    console.error("[orders/init] 予期しないエラー:", err);
    return Response.json(
      {
        success: false,
        message:
          "初期化に失敗しました。同じ画面では再押下せず、画面を再読み込みして状態を確認してください。",
      },
      { status: 500 }
    );
  } finally {
    await releaseWorkflowLease(lease).catch(() => false);
  }
}

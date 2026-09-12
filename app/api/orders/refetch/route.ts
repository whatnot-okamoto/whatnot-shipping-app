// POST /api/orders/refetch
// BASE APIから最新の注文情報を取得し、order_snapshot_pendingを生成して差分を判定する。
// U1・U2・U4・order_snapshot は更新しない（DATA-01 T1原則）。

import { randomUUID } from "crypto";
import { redis } from "@/lib/upstash";
import { fetchOrderedOrders, fetchOrderDetail } from "@/lib/base-api";
import {
  getOrderSnapshot,
  getOrderSnapshots,
  buildOrderSnapshotFromDetail,
  type OrderSnapshot,
} from "@/lib/order-store";
import {
  createInitialRefetchState,
  getRefetchState,
  setRefetchStateFenced,
} from "@/lib/refetch-store";
import type { RefetchOrderResult } from "@/lib/refetch-store";
import { requireAuth } from "@/lib/auth";
import { getStaffReviewSnapshotChanges } from "@/lib/order-snapshot-diff";
import { assessOrderForPdf } from "@/lib/pdf-order-assessment";
import {
  acquireWorkflowLease,
  DIFF_CONFIRM_CHUNK_SIZE,
  fencedMutate,
  releaseWorkflowLease,
  renewWorkflowLeaseIfDue,
  WorkflowLeaseLostError,
} from "@/lib/workflow-operation-lease";

export type DiffItem = {
  unique_key: string;
  diff_type: "item_changed" | "cancelled" | "fee_changed" | "new_order" | "disappeared" | "other";
  description: string;
  severity: "info" | "warning" | "blocking";
};

const REFETCH_BASE_REQUEST_TIMEOUT_MS = 15_000;

async function withBaseRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const signal = AbortSignal.timeout(REFETCH_BASE_REQUEST_TIMEOUT_MS);
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

function baseOrdersFetchFailureResponse(): Response {
  return Response.json(
    {
      success: false,
      error_type: "retryable_error",
      error_code: "base_orders_fetch_failed",
      error: "BASE注文一覧を取得できませんでした。注文一覧を維持したまま再試行してください。",
    },
    { status: 503 }
  );
}

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

  let sourceRefetchCycleId: string | null = null;
  try {
    const body = await req.clone().json();
    if (
      body &&
      typeof body === "object" &&
      "source_refetch_cycle_id" in body &&
      typeof (body as { source_refetch_cycle_id?: unknown }).source_refetch_cycle_id === "string"
    ) {
      sourceRefetchCycleId = (body as { source_refetch_cycle_id: string }).source_refetch_cycle_id;
    }
  } catch {
    // Body is optional for an ordinary refetch.
  }

  const lease = await acquireWorkflowLease("refetch", sourceRefetchCycleId);
  if (!lease) {
    return Response.json(
      { success: false, error: "別の更新処理が進行中です。" },
      { status: 409 }
    );
  }

  try {
    const previousState = await getRefetchState();
    const isAuthorizedPostInitRefetch =
      previousState?.has_new_uninitialized === true &&
      previousState.post_init_refetch_ready === true &&
      previousState.refetch_cycle_id === sourceRefetchCycleId;
    const mustRejectUnconfirmedRefetch =
      previousState?.refetch_done_flag === true &&
      previousState.diff_confirmed_flag !== true &&
      !isAuthorizedPostInitRefetch;
    if (mustRejectUnconfirmedRefetch) {
      return Response.json(
        { success: false, error: "未確認の差分があります。先に内容を確認してください。" },
        { status: 409 }
      );
    }

    // 手順1: refetch_stateを初期化
    const refetchCycleId = randomUUID();
    await setRefetchStateFenced(lease, createInitialRefetchState(refetchCycleId));

    // 手順2: 既存のpendingを全削除
    const oldPendingKeys = await redis.smembers("index:order_snapshot_pending");
    await fencedMutate(lease, [
      ...(oldPendingKeys.length > 0
        ? [{
            type: "del" as const,
            keys: oldPendingKeys.map((key) => `order_snapshot_pending:${key}`),
          }]
        : []),
      { type: "del", keys: ["index:order_snapshot_pending"] },
    ]);

    // 手順3: BASE一覧取得 + 3条件フィルタ
    let baseOrders;
    try {
      baseOrders = await withBaseRequestTimeout((signal) =>
        fetchOrderedOrders({ signal })
      );
    } catch {
      return baseOrdersFetchFailureResponse();
    }
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

    const pendingSnapshots = new Map<string, OrderSnapshot>();
    for (const uniqueKey of existingWithSnapshot) {
      await renewWorkflowLeaseIfDue(lease);
      try {
        const [detail, existingSnap] = await Promise.all([
          withBaseRequestTimeout((signal) =>
            fetchOrderDetail(uniqueKey, { signal })
          ),
          getOrderSnapshot(uniqueKey),
        ]);
        if (!existingSnap) continue; // 取得競合（稀）

        const assessment = assessOrderForPdf(detail);
        const pending = buildOrderSnapshotFromDetail(
          detail,
          existingSnap.bundle_group_id,
          refetchCycleId
        );
        pendingSnapshots.set(uniqueKey, pending);
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

    // 消えた注文をdiff_summaryに追加。snapshot read/pending writeは一括する。
    const disappearedSnapshots = await getOrderSnapshots(disappeared);
    const disappearedPendingSnapshots = new Map<string, OrderSnapshot>();
    for (const key of disappeared) {
      const existingSnapshot = disappearedSnapshots.get(key);
      if (existingSnapshot) {
        const pending: OrderSnapshot = {
          ...existingSnapshot,
          pdf_verification_cycle_id: refetchCycleId,
          open_order_presence: "not_in_open_orders",
          pdf_generation_outcome: "blocked",
          pdf_issue_codes: ["not_in_open_orders"],
        };
        disappearedPendingSnapshots.set(key, pending);
      }
      orderResults[key] = {
        status: "not_in_open_orders",
        issues: ["not_in_open_orders"],
      };
      if (existingSnapshot?.open_order_presence !== "not_in_open_orders") {
        // 初回不在は件数で集約し、現在注文の確認を埋めない。
      }
    }
    for (const [key, snapshot] of disappearedPendingSnapshots) {
      pendingSnapshots.set(key, snapshot);
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
    const pendingEntries = [...pendingSnapshots.entries()];
    for (let offset = 0; offset < pendingEntries.length; offset += DIFF_CONFIRM_CHUNK_SIZE) {
      await renewWorkflowLeaseIfDue(lease);
      const chunk = pendingEntries.slice(offset, offset + DIFF_CONFIRM_CHUNK_SIZE);
      await fencedMutate(lease, [
        ...chunk.map(([key, snapshot]) => ({
          type: "set" as const,
          key: `order_snapshot_pending:${key}`,
          value: JSON.stringify(snapshot),
        })),
        {
          type: "sadd" as const,
          key: "index:order_snapshot_pending",
          members: chunk.map(([key]) => key),
        },
      ]);
    }

    const firstAbsenceCount = disappeared.filter(
      (key) =>
        disappearedSnapshots.has(key) &&
        disappearedSnapshots.get(key)?.open_order_presence !== "not_in_open_orders"
    ).length;
    await setRefetchStateFenced(lease, {
      refetch_done_flag: true,
      diff_confirmed_flag: false,
      refetched_at: new Date().toISOString(),
      has_new_uninitialized: hasNewUninitialized,
      refetch_cycle_id: refetchCycleId,
      refetch_result: failedUniqueKeys.length > 0 ? "partial" : "complete",
      phase: hasNewUninitialized ? "awaiting_initialization" : "awaiting_review",
      new_uninitialized_count: newOrders.length,
      post_init_refetch_ready: false,
      order_results: orderResults,
    });

    // 手順8: レスポンス返却
    return Response.json({
      success: true,
      refetch_done_flag: true,
      diff_confirmed_flag: false,
      diff_result: {
        refetch_cycle_id: refetchCycleId,
        has_diff: diffSummary.length > 0 || firstAbsenceCount > 0,
        has_new_uninitialized: hasNewUninitialized,
        new_uninitialized_count: newOrders.length,
        first_absence_count: firstAbsenceCount,
        has_fetch_failures: failedUniqueKeys.length > 0,
        failed_unique_keys: failedUniqueKeys,
        diff_summary: diffSummary,
      },
    });
  } catch (error) {
    if (error instanceof WorkflowLeaseLostError) {
      return Response.json(
        { success: false, error: "更新権限が失効しました。再読み込みしてください。" },
        { status: 409 }
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  } finally {
    await releaseWorkflowLease(lease).catch(() => false);
  }
}

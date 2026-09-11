// GET /api/orders/list
// index:orders × BASE現在未対応一覧の積集合を起点に U1 / snapshot / U2 / U3 / U4派生値を合成して返す。
// 読み取り専用。BASE詳細APIは叩かない。自動initは行わない。

import { redis } from "@/lib/upstash";
import {
  getOrderStates,
  getOrderSnapshots,
  getBundleStates,
  getPickingProgress,
  derivePickingStatus,
  type U1Data,
  type OrderSnapshot,
  type U2Data,
} from "@/lib/order-store";
import { getCurrentSession } from "@/lib/session-store";
import { fetchOrderedOrders } from "@/lib/base-api";
import { getRefetchState } from "@/lib/refetch-store";
import { requireAuth } from "@/lib/auth";
import { BaseReadonlyReauthorizationRequiredError } from "@/lib/base-readonly-oauth";
import type { BaseOrderSummary } from "@/lib/base-api";
import {
  compareOrdersNewestFirst,
  resolveOrderedTimestamp,
} from "@/lib/order-list-ordering";
import {
  buildBaseReviewGuidance,
  GENERATION_ISSUE_LABELS,
} from "@/lib/order-generation-messages";

// U1 欠損時の安全な初期値（表示用の仮値。正常初期化済み扱いにしない）
const FALLBACK_U1: Omit<U1Data, "unique_key"> = {
  hold_flag: false,
  hold_reason: "",
  carrier: "",
  receipt_required: false,
  receipt_name: "",
  receipt_note: "",
  app_memo: "",
  cancelled_flag: false,
};

// Snapshot 欠損時の安全な初期値（表示用の仮値。正常初期化済み扱いにしない）
const FALLBACK_SNAPSHOT: Omit<OrderSnapshot, "unique_key"> = {
  bundle_group_id: "",
  receiver_name: "",
  order_date: "",
  shipping_method_name: "",
  shipping_fee: 0,
  shipping_lines_count: 0,
  has_multiple_shipping_lines: false,
  shipping_category: "",
  remark: "",
  item_count: 0,
  items_summary: "",
};

export async function GET(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  try {
    // ステップ1: BASE一覧APIで現在の未対応注文 unique_key 一覧を取得
    // 失敗時は index:orders のみで継続しない
    let baseOpenUniqueKeys: Set<string>;
    let baseOpenOrdersByKey: Map<string, BaseOrderSummary>;
    let baseRawOrderCount: number;
    let baseOpenOrderCount: number;
    try {
      const baseOrders = await fetchOrderedOrders();
      baseRawOrderCount = baseOrders.length;

      const baseOpenOrders = baseOrders.filter(
        (o) =>
          o.dispatch_status === "ordered" &&
          o.dispatched === null &&
          o.terminated === false
      );
      baseOpenOrdersByKey = new Map(
        baseOpenOrders.map((order) => [order.unique_key, order])
      );
      baseOpenUniqueKeys = new Set(baseOpenOrdersByKey.keys());
      baseOpenOrderCount = baseOpenOrders.length;
    } catch (e) {
      if (e instanceof BaseReadonlyReauthorizationRequiredError) {
        return Response.json(
          {
            success: false,
            status: "base_readonly_reauth_required",
            error: "Development用BASE read-only認証が必要です。",
            reauth_url: "/orders/readonly-reauth",
          },
          { status: 503 }
        );
      }
      const message = e instanceof Error ? e.message : "Unknown error";
      return Response.json(
        { success: false, status: "base_api_error", error: `BASE APIの取得に失敗しました: ${message}` },
        { status: 502 }
      );
    }

    // index:orders から unique_key 一覧を取得
    const indexUniqueKeys: string[] = await redis.smembers("index:orders");
    const indexOrderCount = indexUniqueKeys.length;

    // ステップ2: 表示対象 = index:orders ∩ BASE現在未対応unique_key一覧（集合演算）
    const filteredUniqueKeys = indexUniqueKeys.filter((uk) => baseOpenUniqueKeys.has(uk));

    // stale_index_count: index:orders に存在するが BASE未対応一覧にない unique_key の件数
    const staleIndexCount = indexUniqueKeys.filter((uk) => !baseOpenUniqueKeys.has(uk)).length;

    // セッション情報（U3）を取得
    const session = await getCurrentSession();
    const currentRefetchState = await getRefetchState();

    // U1 と snapshot を並列取得
    const [u1Map, snapshotMap] = await Promise.all([
      getOrderStates(filteredUniqueKeys),
      getOrderSnapshots(filteredUniqueKeys),
    ]);

    // snapshot から bundle_group_id を収集し U2 を一括取得
    const bundleGroupIds = new Set<string>();
    for (const snap of snapshotMap.values()) {
      if (snap.bundle_group_id) bundleGroupIds.add(snap.bundle_group_id);
    }
    const bundleMap: Map<string, U2Data> = await getBundleStates([...bundleGroupIds]);

    // ピッキング進捗を並列取得して picking_status を派生計算
    const pickingEntries = await Promise.all(
      filteredUniqueKeys.map(async (uk) => {
        const items = await getPickingProgress(uk);
        return [uk, derivePickingStatus(items)] as const;
      })
    );
    const pickingStatusMap = new Map(pickingEntries);

    // 各注文のフィールドを合成し selectable / disabled_reason を決定
    const orders = filteredUniqueKeys.map((uk) => {
      const u1 = u1Map.get(uk);
      const snap = snapshotMap.get(uk);
      const needs_initialization = !u1 || !snap;

      const safeU1 = u1 ?? { unique_key: uk, ...FALLBACK_U1 };
      const safeSnap = snap ?? { unique_key: uk, ...FALLBACK_SNAPSHOT };

      const bundle = safeSnap.bundle_group_id
        ? bundleMap.get(safeSnap.bundle_group_id)
        : undefined;

      const picking_status = pickingStatusMap.get(uk) ?? "not_started";
      const orderResult = currentRefetchState?.order_results?.[uk];
      const orderIssues = orderResult?.issues ?? safeSnap.pdf_issue_codes ?? [];
      const bundleProblemOrders = (bundle?.order_unique_keys ?? []).flatMap(
        (bundleUniqueKey) => {
          const result = currentRefetchState?.order_results?.[bundleUniqueKey];
          const isProblem =
            result?.status === "verified_blocked" ||
            result?.status === "fetch_failed" ||
            result?.status === "not_in_open_orders";
          if (!result || !isProblem) return [];

          const reason =
            result.status === "fetch_failed"
              ? "今回の再取得で注文詳細を取得できませんでした"
              : result.status === "not_in_open_orders"
                ? GENERATION_ISSUE_LABELS.not_in_open_orders
                : result.issues
                    .map((issue) => GENERATION_ISSUE_LABELS[issue])
                    .join(" ");
          return [{ unique_key: bundleUniqueKey, reason }];
        }
      );
      const bundleProblemUniqueKeys = bundleProblemOrders.map(
        (problem) => problem.unique_key
      );

      // selectable_for_session 判定（優先順位順に評価）
      let selectable_for_session = true;
      let disabled_reason: string | null = null;

      if (needs_initialization) {
        selectable_for_session = false;
        disabled_reason = "初期化が必要です（再取得を実行してください）";
      } else if (safeU1.cancelled_flag) {
        selectable_for_session = false;
        disabled_reason = "キャンセル済みの注文です";
      } else if (orderResult?.status === "fetch_failed") {
        selectable_for_session = false;
        disabled_reason = "今回の再取得で注文詳細を取得できませんでした。再取得してください";
      } else if (orderResult?.status === "verified_blocked") {
        selectable_for_session = false;
        disabled_reason = orderIssues.map((issue) => GENERATION_ISSUE_LABELS[issue]).join(" ");
      } else if (bundleProblemUniqueKeys.some((key) => key !== uk)) {
        selectable_for_session = false;
        disabled_reason = "同じU2にアプリで処理できない注文が含まれています";
      } else if (safeSnap.has_multiple_shipping_lines) {
        selectable_for_session = false;
        disabled_reason = "C-5未確認：配送方法が複数件あります";
      } else if (safeSnap.shipping_category === "unknown") {
        selectable_for_session = false;
        disabled_reason = "配送方法が未登録です";
      } else if (safeU1.hold_flag) {
        selectable_for_session = false;
        disabled_reason = "保留中の注文です";
      }

      return {
        unique_key: uk,
        ordered_timestamp: resolveOrderedTimestamp(
          baseOpenOrdersByKey.get(uk)?.ordered,
          safeSnap.ordered_timestamp
        ),
        receiver_name: safeSnap.receiver_name,
        order_date: safeSnap.order_date,
        shipping_method_name: safeSnap.shipping_method_name,
        shipping_fee: safeSnap.shipping_fee,
        shipping_category: safeSnap.shipping_category,
        remark: safeSnap.remark,  // 表示用途のみ。ログ出力禁止
        item_count: safeSnap.item_count,
        items_summary: safeSnap.items_summary,
        carrier: safeU1.carrier,
        hold_flag: safeU1.hold_flag,
        hold_reason: safeU1.hold_reason,
        receipt_required: safeU1.receipt_required,
        receipt_name: safeU1.receipt_name,
        receipt_note: safeU1.receipt_note,
        app_memo: safeU1.app_memo,
        cancelled_flag: safeU1.cancelled_flag,
        bundle_group_id: safeSnap.bundle_group_id,
        bundle_order_unique_keys: bundle?.order_unique_keys ?? [],
        bundle_enabled: bundle?.bundle_enabled ?? false,
        picking_status: picking_status as "completed" | "in_progress" | "not_started",
        needs_initialization,
        has_multiple_shipping_lines: safeSnap.has_multiple_shipping_lines,
        has_unknown_shipping_method:
          !needs_initialization && safeSnap.shipping_category === "unknown",
        selectable_for_session,
        disabled_reason,
        processing_issues: orderIssues,
        processing_guidance:
          orderResult?.status === "fetch_failed"
            ? "一時的な取得失敗です。緊急解除は不要です。この画面で再取得してください。別U2の確認済み注文は継続できます。"
            : orderIssues.length > 0
              ? buildBaseReviewGuidance(orderIssues)
              : bundleProblemOrders.length > 0
                ? "同じU2内の注文は切り離せません。各注文をBASEで確認し、このU2を外せる状態にしてから再取得してください。正常な別U2は継続できます。"
                : null,
        bundle_problem_orders: bundleProblemOrders,
      };
    });

    // UI-LIST-ORDER-01: 要確認先頭固定を行わず、BASE orderedの新しい順に統一する。
    orders.sort(compareOrdersNewestFirst);

    const uninitialized_count = orders.filter((o) => o.needs_initialization).length;
    const unselectable_count = orders.filter((o) => !o.selectable_for_session).length;

    // session_status=active: U3のフラグを使用
    // それ以外: orders:refetch_stateのフラグを使用（セッションなし・完了・緊急解除後）
    let refetchDoneFlag = false;
    let diffConfirmedFlag = false;
    if (session?.session_status === "active") {
      refetchDoneFlag = session.refetch_done_flag;
      diffConfirmedFlag = session.diff_confirmed_flag;
    } else {
      refetchDoneFlag = currentRefetchState?.refetch_done_flag ?? false;
      diffConfirmedFlag = currentRefetchState?.diff_confirmed_flag ?? false;
    }

    return Response.json({
      success: true,
      status: "ok",
      session: session
        ? {
            session_status: session.session_status,
            locked_bundle_group_ids: session.locked_bundle_group_ids,
            refetch_done_flag: refetchDoneFlag,
            diff_confirmed_flag: diffConfirmedFlag,
          }
        : {
            session_status: "none",
            locked_bundle_group_ids: [],
            refetch_done_flag: refetchDoneFlag,
            diff_confirmed_flag: diffConfirmedFlag,
          },
      orders,
      meta: {
        total_order_count: orders.length,
        uninitialized_count,
        unselectable_count,
        base_raw_order_count: baseRawOrderCount,
        base_open_order_count: baseOpenOrderCount,
        index_order_count: indexOrderCount,
        displayed_order_count: orders.length,
        stale_index_count: staleIndexCount,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json(
      { success: false, status: "failed", error: message },
      { status: 500 }
    );
  }
}

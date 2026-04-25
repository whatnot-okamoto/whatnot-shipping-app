// GET /api/orders/list
// index:orders を起点に U1 / snapshot / U2 / U3 / U4派生値を合成して返す。
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

// Upstash Redis に直接アクセスするため @/lib/upstash をインポート
export async function GET() {
  try {
    // 手順1: index:orders から unique_key 一覧を取得
    const uniqueKeys: string[] = await redis.smembers("index:orders");

    // 手順2: セッション情報（U3）を取得
    const session = await getCurrentSession();

    // 手順3: U1 と snapshot を並列取得
    const [u1Map, snapshotMap] = await Promise.all([
      getOrderStates(uniqueKeys),
      getOrderSnapshots(uniqueKeys),
    ]);

    // 手順4: snapshot から bundle_group_id を収集し U2 を一括取得
    const bundleGroupIds = new Set<string>();
    for (const snap of snapshotMap.values()) {
      if (snap.bundle_group_id) bundleGroupIds.add(snap.bundle_group_id);
    }
    const bundleMap: Map<string, U2Data> = await getBundleStates([...bundleGroupIds]);

    // 手順5: ピッキング進捗を並列取得して picking_status を派生計算
    const pickingEntries = await Promise.all(
      uniqueKeys.map(async (uk) => {
        const items = await getPickingProgress(uk);
        return [uk, derivePickingStatus(items)] as const;
      })
    );
    const pickingStatusMap = new Map(pickingEntries);

    // 手順6: 各注文のフィールドを合成し selectable / disabled_reason を決定
    const orders = uniqueKeys.map((uk) => {
      const u1 = u1Map.get(uk);
      const snap = snapshotMap.get(uk);
      const needs_initialization = !u1 || !snap;

      const safeU1 = u1 ?? { unique_key: uk, ...FALLBACK_U1 };
      const safeSnap = snap ?? { unique_key: uk, ...FALLBACK_SNAPSHOT };

      const bundle = safeSnap.bundle_group_id
        ? bundleMap.get(safeSnap.bundle_group_id)
        : undefined;

      const picking_status = pickingStatusMap.get(uk) ?? "not_started";

      // selectable_for_session 判定（優先順位順に評価）
      let selectable_for_session = true;
      let disabled_reason: string | null = null;

      if (needs_initialization) {
        selectable_for_session = false;
        disabled_reason = "初期化が必要です（再取得を実行してください）";
      } else if (safeU1.cancelled_flag) {
        selectable_for_session = false;
        disabled_reason = "キャンセル済みの注文です";
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
      };
    });

    // 手順7: ソート（非selectable先頭 → order_date昇順 → unique_key昇順）
    orders.sort((a, b) => {
      if (a.selectable_for_session !== b.selectable_for_session) {
        return a.selectable_for_session ? 1 : -1;
      }
      if (a.order_date !== b.order_date) {
        return a.order_date < b.order_date ? -1 : 1;
      }
      return a.unique_key < b.unique_key ? -1 : 1;
    });

    const uninitialized_count = orders.filter((o) => o.needs_initialization).length;
    const unselectable_count = orders.filter((o) => !o.selectable_for_session).length;

    return Response.json({
      success: true,
      status: "ok",
      session: session
        ? {
            session_status: session.session_status,
            locked_bundle_group_ids: session.locked_bundle_group_ids,
            refetch_done_flag: session.refetch_done_flag,
            diff_confirmed_flag: session.diff_confirmed_flag,
          }
        : {
            session_status: "none",
            locked_bundle_group_ids: [],
            refetch_done_flag: false,
            diff_confirmed_flag: false,
          },
      orders,
      meta: {
        total_order_count: orders.length,
        uninitialized_count,
        unselectable_count,
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

// GET /api/session/current
// 現在のセッション状態を返す。
// session:current が未設定の場合は { session: null } を返す（セッションなし）。
//
// session_status === "active" の場合は locked_bundles（U2展開情報）を追加で返す。
// LockedStageView の表示に必要なデータを一括取得する（Step 4-B §10）。
//
// 参照順序: session:current → session_id → session:{session_id}
// （DATA-01 §5 session:currentポインタ構造）

import { getCurrentSession } from "@/lib/session-store";
import { getBundleStates, getOrderStates, getOrderSnapshots } from "@/lib/order-store";
import { requireAuth } from "@/lib/auth";

export type LockedBundleInfo = {
  bundle_group_id: string;
  /** 代表注文ID（実値は unique_key。ORDER-FIELD-01準拠） */
  representative_order_id: string;
  /** 配下注文IDリスト（実値は unique_key 配列。ORDER-FIELD-01準拠） */
  order_ids: string[];
  carrier: string;
  receiver_name: string;
  /** hold_flag === true の配下U1が存在する場合 true（原則 false。C6により除外済みのため、true はデータ不整合） */
  hold_flag_anomaly: boolean;
  /** 配下U1のいずれかに receipt_required === true がある場合 true */
  receipt_required: boolean;
  /** receipt_required===true かつ receipt_name が空の配下U1が存在する場合 true（領収書宛名未入力警告用） */
  receipt_name_empty: boolean;
};

export async function GET(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  try {
    const session = await getCurrentSession();

    // session なし、または active 以外のステータスはそのまま返す
    if (!session || session.session_status !== "active") {
      return Response.json({ session });
    }

    // session_status === "active": locked_bundles を展開して返す（Step 4-B §8 参照のみ）
    const bundleMap = await getBundleStates(session.locked_bundle_group_ids);

    // 全ロック対象 unique_key を収集
    const allUniqueKeySet = new Set<string>();
    for (const bgId of session.locked_bundle_group_ids) {
      const bundle = bundleMap.get(bgId);
      if (bundle) {
        for (const uk of bundle.order_unique_keys) {
          allUniqueKeySet.add(uk);
        }
      }
    }
    const allUniqueKeys = [...allUniqueKeySet];

    // U1 と snapshot を並列取得（bundle:{id}・order:{unique_key} は変更しない。参照のみ）
    const [u1Map, snapshotMap] = await Promise.all([
      getOrderStates(allUniqueKeys),
      getOrderSnapshots(allUniqueKeys),
    ]);

    const lockedBundles: LockedBundleInfo[] = session.locked_bundle_group_ids
      .map((bgId): LockedBundleInfo | null => {
        const bundle = bundleMap.get(bgId);
        if (!bundle) return null;

        const orderIds = bundle.order_unique_keys;
        // order_id という変数名を使う場合、実値は unique_key（string）（ORDER-FIELD-01読み替え）
        const repId = bundle.representative_order_unique_key;

        // carrier: 配下U1の最初の有効な carrier を代表値とする（C5でロック前に検証済み）
        let carrier = "";
        for (const uk of orderIds) {
          const u1 = u1Map.get(uk);
          if (u1?.carrier) {
            carrier = u1.carrier;
            break;
          }
        }

        // receiver_name: 代表注文の snapshot から取得
        const receiverName = snapshotMap.get(repId)?.receiver_name ?? "";

        // hold_flag_anomaly: 配下U1 に hold_flag === true があればデータ不整合（原則 false）
        const holdFlagAnomaly = orderIds.some((uk) => u1Map.get(uk)?.hold_flag === true);

        // receipt_required: 配下U1 のいずれかに true があれば true
        const receiptRequired = orderIds.some((uk) => u1Map.get(uk)?.receipt_required === true);

        // receipt_name_empty: receipt_required===true かつ receipt_name が空の U1 が存在すれば true
        const receiptNameEmpty = orderIds.some((uk) => {
          const u1 = u1Map.get(uk);
          return u1?.receipt_required === true && !u1?.receipt_name;
        });

        return {
          bundle_group_id: bgId,
          representative_order_id: repId,
          order_ids: orderIds,
          carrier,
          receiver_name: receiverName,
          hold_flag_anomaly: holdFlagAnomaly,
          receipt_required: receiptRequired,
          receipt_name_empty: receiptNameEmpty,
        };
      })
      .filter((b): b is LockedBundleInfo => b !== null);

    return Response.json({ session, locked_bundles: lockedBundles });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

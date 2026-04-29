// POST /api/session/start
// T5ロック発動（Step 4-B）
//
// Body: { selected_unique_keys: string[] }
//
// U2展開手順（Step 4-B §4 準拠）:
//   ① selected_unique_keys リストを受け取る
//   ② 各 unique_key の bundle_group_id を order_snapshot から取得
//   ③ bundle_group_id を重複排除して locked_bundle_group_ids 候補を作成
//   ④ 各 U2 の order_unique_keys を展開 → ロック対象U1全件
//   ⑤ C5・C6 を検証（ロック対象U1全件）
//   ⑥ T5 を実行して U3 を作成（startSession）
//
// C5・C6 の検証対象は「U2展開後のロック対象U1全件」。選択U1のみを検証対象にしない。

import { startSession } from "@/lib/session-store";
import { getRefetchState } from "@/lib/refetch-store";
import { getOrderSnapshots, getBundleStates, getOrderStates } from "@/lib/order-store";
import { requireAuth } from "@/lib/auth";

export async function POST(request: Request) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("selected_unique_keys" in body) ||
    !Array.isArray((body as { selected_unique_keys: unknown }).selected_unique_keys)
  ) {
    return Response.json(
      { error: "INVALID_BODY: selected_unique_keys must be an array" },
      { status: 400 }
    );
  }

  // order_id という変数名を使う場合、実値は unique_key（string）であることに注意（ORDER-FIELD-01読み替え）
  const { selected_unique_keys } = body as { selected_unique_keys: string[] };

  // C1: 選択注文が1件以上存在すること
  if (selected_unique_keys.length === 0) {
    return Response.json(
      { error: "NO_ORDERS_SELECTED: 注文を1件以上選択してください" },
      { status: 400 }
    );
  }

  // C2・C3・C4: 再取得・差分確認が完了していない場合はセッション開始を拒否（Step 4-A3実装済み）
  const refetchState = await getRefetchState();
  if (
    !refetchState ||
    refetchState.refetch_done_flag !== true ||
    refetchState.diff_confirmed_flag !== true ||
    refetchState.has_new_uninitialized === true
  ) {
    return Response.json(
      { error: "REFETCH_REQUIRED: 再取得・差分確認を完了してからセッションを開始してください" },
      { status: 409 }
    );
  }

  // U2展開: ②〜④
  // ② 各 unique_key の bundle_group_id を order_snapshot から取得（Upstashキー: order:{unique_key} ORDER-FIELD-01準拠）
  const snapshotMap = await getOrderSnapshots(selected_unique_keys);

  // ③ bundle_group_id を重複排除して locked_bundle_group_ids を作成
  const bundleGroupIdSet = new Set<string>();
  for (const uk of selected_unique_keys) {
    const snap = snapshotMap.get(uk);
    if (snap?.bundle_group_id) {
      bundleGroupIdSet.add(snap.bundle_group_id);
    }
  }
  const locked_bundle_group_ids = [...bundleGroupIdSet];

  // ④ 各 U2 の order_unique_keys を展開 → ロック対象U1全件
  const bundleMap = await getBundleStates(locked_bundle_group_ids);
  const expandedUniqueKeySet = new Set<string>();
  for (const bgId of locked_bundle_group_ids) {
    const bundle = bundleMap.get(bgId);
    if (bundle) {
      for (const uk of bundle.order_unique_keys) {
        expandedUniqueKeySet.add(uk);
      }
    }
  }
  const expandedUniqueKeys = [...expandedUniqueKeySet];

  // ⑤ C5・C6 検証（ロック対象U1全件。Upstashキー: order:{unique_key} ORDER-FIELD-01準拠）
  const u1Map = await getOrderStates(expandedUniqueKeys);

  // C5: ロック対象U1全件の carrier が確定済みであること（空文字・未設定は不成立）
  const unsetCarrierKeys: string[] = [];
  for (const uk of expandedUniqueKeys) {
    const u1 = u1Map.get(uk);
    if (!u1 || !u1.carrier) {
      unsetCarrierKeys.push(uk);
    }
  }
  if (unsetCarrierKeys.length > 0) {
    return Response.json(
      {
        error: "CARRIER_NOT_SET: ロック対象に配送業者が未選択の注文があります",
        unset_carrier_keys: unsetCarrierKeys,
      },
      { status: 400 }
    );
  }

  // C6: ロック対象U1全件に hold_flag === true が含まれないこと
  const holdFlagKeys: string[] = [];
  for (const uk of expandedUniqueKeys) {
    const u1 = u1Map.get(uk);
    if (u1?.hold_flag === true) {
      holdFlagKeys.push(uk);
    }
  }
  if (holdFlagKeys.length > 0) {
    return Response.json(
      {
        error: "HOLD_FLAG_SET: ロック対象に保留中の注文が含まれています",
        hold_flag_keys: holdFlagKeys,
      },
      { status: 400 }
    );
  }

  // LOCK-CONDITION-01: picking_status === "completed" は一時除外
  // PICK系機能（ピッキングUI/API）が未実装のため、本条件をロック可能条件から除外している。
  // PICK系機能の実装完了後に、全選択注文の picking_status === "completed" を
  // ロック可能条件（C7）として必ず復帰させること。
  // 残論点管理リスト: LOCK-CONDITION-01（後続保持・PICK系実装後に復帰必須）

  // ⑥ T5: セッション開始（U3作成・orders:refetch_state削除）
  try {
    const session = await startSession(locked_bundle_group_ids);
    return Response.json({
      success: true,
      session,
      locked_bundle_group_ids,
      expanded_unique_key_count: expandedUniqueKeys.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("SESSION_CONFLICT") ? 409 : 500;
    return Response.json({ error: message }, { status });
  }
}

// U3（セッション単位）Upstash 管理（DATA-01 T5・T6・T7 準拠）
//
// 【対象外フィールド（後続実装）】
//   session:{session_id}:snapshot  ← 再取得時（T1）に生成
//   session:{session_id}:diff_temp ← 差分確認時に生成
//
// 【session:current の役割】
//   ポインタキー。session_id の値のみ保持する。実データを持たせてはならない。
//   未設定 = activeなセッションなし（DATA-01 §5 session:currentポインタ構造）

import { redis } from "@/lib/upstash";
import { getRefetchState, deleteRefetchState } from "@/lib/refetch-store";

// ============================================================================
// 型定義
// ============================================================================

export type SessionStatus = "active" | "completed" | "unlocked";

/** 緊急解除ログの1エントリ。クリア禁止・追記のみ（DATA-01 T7）。 */
export type EmergencyUnlockLogEntry = {
  executed_by: string;
  unlocked_at: string;  // ISO 8601
  reason: string;
};

/**
 * U3: `session:{session_id}` に保存するデータ本体。
 * snapshot・diff_temp は別キーで後続実装（本型には含まない）。
 */
export type U3Data = {
  session_id: string;
  session_status: SessionStatus;
  locked_bundle_group_ids: string[];
  refetch_done_flag: boolean;
  diff_confirmed_flag: boolean;
  checklist_printed_flag: boolean;
  /** 緊急解除ログ。永続保持・クリア禁止。追記のみ許可（DATA-01 T7）。 */
  emergency_unlock_log: EmergencyUnlockLogEntry[];
};

// ============================================================================
// セッション開始（T5）
// ============================================================================

/**
 * セッションを開始し、注文集合をロックする。
 *
 * 実装順序（DATA-01 §5 セッション開始の順序・逆転禁止）:
 *   1. session_id を UUID で生成する
 *   2. `session:{session_id}` に完成した JSON を一括書き込む
 *      （locked_bundle_group_ids 確定 + session_status=active を同時に確定する）
 *   3. `SET session:current NX` で session_id を書き込む
 *      - NX: 存在しない場合のみ成功。並行セッション開始を構造的に排除する。
 *      - 失敗時: `session:{session_id}` を削除して中途半端な状態を残さずエラーを返す
 *
 * @param lockedBundleGroupIds ロックする bundle_group_id の集合
 */
export async function startSession(
  lockedBundleGroupIds: string[]
): Promise<U3Data> {
  // T5：orders:refetch_stateのフラグをU3へコピーする
  const refetchState = await getRefetchState();
  const refetchDoneFlag = refetchState?.refetch_done_flag ?? false;
  const diffConfirmedFlag = refetchState?.diff_confirmed_flag ?? false;

  const sessionId = crypto.randomUUID();

  // locked_bundle_group_ids・session_status=active・引き継ぎフラグを含む完成データを一括書き込む
  // session:current より先に書くことで、ポインタが先行するケースを排除する
  const sessionData: U3Data = {
    session_id: sessionId,
    session_status: "active",
    locked_bundle_group_ids: lockedBundleGroupIds,
    refetch_done_flag: refetchDoneFlag,
    diff_confirmed_flag: diffConfirmedFlag,
    checklist_printed_flag: false,
    emergency_unlock_log: [],
  };
  await redis.set(`session:${sessionId}`, JSON.stringify(sessionData));

  // session:current に NX で書き込む（二重生成防止）
  const setResult = await redis.set("session:current", sessionId, { nx: true });

  if (setResult === null) {
    await redis.del(`session:${sessionId}`);
    throw new Error("SESSION_CONFLICT: An active session already exists");
  }

  // session_status=active 確定後に orders:refetch_state を削除（T5完了）
  await deleteRefetchState();

  return sessionData;
}

// ============================================================================
// セッション終了（T6）
// ============================================================================

/**
 * セッションを正常終了する。
 *
 * - session_status を "completed" に更新する
 * - locked_bundle_group_ids・各フラグをクリアする
 * - session:current をクリアする
 *
 * 出荷完了注文の U1・U2・U4 削除は Step 8（出荷完了処理）で実装するため対象外。
 * 保留中注文の U1・U4 は保持する（DATA-01 T6: 次回セッションで再利用）。
 */
export async function endSession(sessionId: string): Promise<void> {
  const raw = await redis.get<string>(`session:${sessionId}`);
  if (!raw) throw new Error("SESSION_NOT_FOUND");

  const current: U3Data =
    typeof raw === "string" ? JSON.parse(raw) : (raw as U3Data);

  const updated: U3Data = {
    ...current,
    session_status: "completed",
    locked_bundle_group_ids: [],
    refetch_done_flag: false,
    diff_confirmed_flag: false,
    checklist_printed_flag: false,
    // emergency_unlock_log はクリアしない（永続保持）
  };

  const pipe = redis.pipeline();
  pipe.set(`session:${sessionId}`, JSON.stringify(updated));
  pipe.del("session:current");
  await pipe.exec();
}

// ============================================================================
// 緊急セッション解除（T7）
// ============================================================================

/**
 * セッションを緊急解除する。
 *
 * - session:{session_id} は削除しない（emergency_unlock_log の監査証跡を永続保持するため）
 * - session_status を "unlocked" に変更する（"completed" とは区別する）
 * - locked_bundle_group_ids・refetch/diff/checklist フラグをクリアする
 * - emergency_unlock_log に解除情報を追記する（クリア禁止・追記のみ）
 * - session:current をクリアする
 *
 * U1・U4 の進捗・設定は維持する（DATA-01 T7: リセットなし）。
 *
 * @param sessionId 解除対象の session_id
 * @param executedBy 実行者（UI から受け取る）
 * @param reason 解除理由（必須。空文字は呼び出し側で事前検証すること）
 */
export async function emergencyUnlockSession(
  sessionId: string,
  executedBy: string,
  reason: string
): Promise<void> {
  const raw = await redis.get<string>(`session:${sessionId}`);
  if (!raw) throw new Error("SESSION_NOT_FOUND");

  const current: U3Data =
    typeof raw === "string" ? JSON.parse(raw) : (raw as U3Data);

  const logEntry: EmergencyUnlockLogEntry = {
    executed_by: executedBy,
    unlocked_at: new Date().toISOString(),
    reason,
  };

  const updated: U3Data = {
    ...current,
    session_status: "unlocked",
    locked_bundle_group_ids: [],
    refetch_done_flag: false,
    diff_confirmed_flag: false,
    checklist_printed_flag: false,
    // 既存ログに追記する。クリアは禁止（DATA-01 T7・§6 禁止事項）
    emergency_unlock_log: [...current.emergency_unlock_log, logEntry],
  };

  const pipe = redis.pipeline();
  pipe.set(`session:${sessionId}`, JSON.stringify(updated));
  pipe.del("session:current");
  await pipe.exec();
}

// ============================================================================
// 現在のセッション状態取得
// ============================================================================

/**
 * 現在アクティブなセッションの U3Data を返す。
 * session:current が未設定の場合は null を返す（セッションなし）。
 *
 * 参照順序: session:current → session_id 取得 → session:{session_id} 参照
 * （DATA-01 §5 session:currentポインタ構造）
 */
export async function getCurrentSession(): Promise<U3Data | null> {
  const sessionId = await redis.get<string>("session:current");
  if (!sessionId) return null;

  const raw = await redis.get<string>(`session:${sessionId}`);
  if (!raw) return null;

  return typeof raw === "string" ? JSON.parse(raw) : (raw as U3Data);
}

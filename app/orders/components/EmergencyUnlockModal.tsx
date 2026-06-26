"use client";

// SESSION-UNLOCK-UI-01 Phase 2
// 緊急セッション解除確認モーダル（概要設計書 7-2④・SAFEGUARD-01 最重点リスク②）
//
// 安全停止ルール（補正2）：
//   session.user.name が取得できない（undefined または trim後空文字）場合、
//   解除ボタンを非活性にし、エラーメッセージを表示する。
//   executed_by を "unknown" 等の固定文字列・補完値で代替することは禁止。

import { useState } from "react";
import { useSession } from "next-auth/react";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onUnlockSuccess: () => Promise<void> | void;
};

// SESSION-UNLOCK-REASON-PRESET-01: 緊急解除理由のプリセット（4択）
// 表示文言は監査ログに reason として残るため一字一句変更しない。
type ReasonKey = "order" | "carrier" | "document" | "other";

const REASON_PRESETS: { key: ReasonKey; label: string }[] = [
  { key: "order", label: "注文内容・金額の変更（キャンセル・同梱・送料など）" },
  { key: "carrier", label: "配送方法・配送業者の変更（ネコポス／佐川／ヤマトなど）" },
  { key: "document", label: "領収書・納品書など帳票内容の修正" },
  { key: "other", label: "その他" },
];

export default function EmergencyUnlockModal({
  isOpen,
  onClose,
  onUnlockSuccess,
}: Props) {
  const { data: sessionData } = useSession();
  const [selectedKey, setSelectedKey] = useState<ReasonKey | null>(null);
  const [supplement, setSupplement] = useState("");
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  if (!isOpen) return null;

  // 補正2 安全停止ルール: session.user.name の取得・検証
  const executedBy = sessionData?.user?.name?.trim() ?? "";
  const isExecutedByMissing = executedBy === "";

  // 解除ボタン活性条件: プリセット選択済み AND session.user.name 非空（両方満たす場合のみ）
  // 「その他」選択時は補足空でも活性（補足任意）。
  const canUnlock = selectedKey !== null && !isExecutedByMissing;

  // 送信時 reason 組み立て（常に非空）
  const buildReason = (key: ReasonKey): string => {
    if (key === "other") {
      const trimmed = supplement.trim();
      return trimmed === "" ? "その他" : `その他: ${trimmed}`;
    }
    return REASON_PRESETS.find((p) => p.key === key)!.label;
  };

  const handleUnlock = async () => {
    // 実装上の安全ガード（UI 上はボタン非活性）: 未選択なら送信しない
    if (selectedKey === null) return;
    // クライアント側防衛チェック（補正2 安全停止ルール）
    if (executedBy === "") return;

    const reason = buildReason(selectedKey);

    setIsUnlocking(true);
    setApiError(null);

    try {
      const res = await fetch("/api/session/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executed_by: executedBy,
          reason,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setApiError(data.error ?? "緊急解除に失敗しました");
        return;
      }

      // 成功: リフレッシュ後にモーダルを閉じる
      await onUnlockSuccess();
      setSelectedKey(null);
      setSupplement("");
      setApiError(null);
      onClose();
    } catch {
      setApiError("ネットワークエラーが発生しました");
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleCancel = () => {
    setSelectedKey(null);
    setSupplement("");
    setApiError(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 flex flex-col">
        {/* ヘッダー */}
        <div className="p-5 border-b">
          <h2 className="text-base font-bold text-red-800">緊急セッション解除</h2>
        </div>

        {/* 本文 */}
        <div className="p-5 space-y-4">
          {/* 確認ダイアログ文言（概要設計書 L165 確定値） */}
          <div className="bg-red-50 border border-red-300 rounded p-3">
            <p className="text-sm text-red-800 font-medium">
              本当に解除しますか？この操作は取り消せません
            </p>
          </div>

          {/* 補正2: session.user.name 取得失敗時のエラー表示 */}
          {isExecutedByMissing && (
            <div className="bg-orange-50 border border-orange-300 rounded p-3">
              <p className="text-sm text-orange-800">
                実行者情報を取得できないため緊急解除を実行できません。再ログインまたは設計役へ確認してください。
              </p>
            </div>
          )}

          {/* reason 選択フィールド（4択ラジオ） */}
          <div>
            <span className="block text-sm font-medium text-gray-700 mb-1">
              解除理由
              <span className="ml-1 text-red-600 text-xs">（必須）</span>
            </span>
            <div className="space-y-2">
              {REASON_PRESETS.map((preset) => (
                <label
                  key={preset.key}
                  className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer"
                >
                  <input
                    type="radio"
                    name="unlock-reason"
                    value={preset.key}
                    checked={selectedKey === preset.key}
                    onChange={() => setSelectedKey(preset.key)}
                    disabled={isUnlocking}
                    className="mt-0.5 disabled:cursor-not-allowed"
                  />
                  <span>{preset.label}</span>
                </label>
              ))}
            </div>

            {/* 「その他」選択時のみ補足入力（任意） */}
            {selectedKey === "other" && (
              <textarea
                value={supplement}
                onChange={(e) => setSupplement(e.target.value)}
                rows={3}
                placeholder="補足（任意）"
                className="mt-2 w-full border border-gray-300 rounded px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-red-400
                           disabled:bg-gray-100 disabled:cursor-not-allowed resize-none"
                disabled={isUnlocking}
              />
            )}
          </div>

          {/* API エラー表示 */}
          {apiError && (
            <div className="bg-red-50 border border-red-300 rounded p-3">
              <p className="text-sm text-red-700">{apiError}</p>
            </div>
          )}
        </div>

        {/* フッターボタン */}
        <div className="p-4 border-t flex gap-3 justify-end flex-wrap">
          {/* キャンセルボタン: 常時活性 */}
          <button
            type="button"
            onClick={handleCancel}
            disabled={isUnlocking}
            className="px-4 py-2 text-sm rounded border border-gray-300 text-gray-700
                       hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            キャンセル
          </button>

          {/* 解除ボタン: reason 非空 AND session.user.name 非空の両方を満たす場合のみ活性 */}
          <button
            type="button"
            onClick={() => { void handleUnlock(); }}
            disabled={!canUnlock || isUnlocking}
            className="px-4 py-2 text-sm rounded bg-red-600 text-white font-medium
                       hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isUnlocking ? "解除中..." : "解除する"}
          </button>
        </div>
      </div>
    </div>
  );
}

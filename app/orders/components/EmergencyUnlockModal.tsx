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

export default function EmergencyUnlockModal({
  isOpen,
  onClose,
  onUnlockSuccess,
}: Props) {
  const { data: sessionData } = useSession();
  const [reason, setReason] = useState("");
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  if (!isOpen) return null;

  // 補正2 安全停止ルール: session.user.name の取得・検証
  const executedBy = sessionData?.user?.name?.trim() ?? "";
  const isExecutedByMissing = executedBy === "";

  const isReasonEmpty = reason.trim() === "";

  // 解除ボタン活性条件: reason 非空 AND session.user.name 非空（両方満たす場合のみ）
  const canUnlock = !isReasonEmpty && !isExecutedByMissing;

  const handleUnlock = async () => {
    // クライアント側防衛チェック（補正2 安全停止ルール）
    if (reason.trim() === "") return;
    if (executedBy === "") return;

    setIsUnlocking(true);
    setApiError(null);

    try {
      const res = await fetch("/api/session/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executed_by: executedBy,
          reason: reason.trim(),
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setApiError(data.error ?? "緊急解除に失敗しました");
        return;
      }

      // 成功: リフレッシュ後にモーダルを閉じる
      await onUnlockSuccess();
      setReason("");
      setApiError(null);
      onClose();
    } catch {
      setApiError("ネットワークエラーが発生しました");
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleCancel = () => {
    setReason("");
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

          {/* reason 入力フィールド */}
          <div>
            <label
              htmlFor="unlock-reason"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              解除理由
              <span className="ml-1 text-red-600 text-xs">（必須）</span>
            </label>
            <textarea
              id="unlock-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="解除理由を入力してください"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-red-400
                         disabled:bg-gray-100 disabled:cursor-not-allowed resize-none"
              disabled={isUnlocking}
            />
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

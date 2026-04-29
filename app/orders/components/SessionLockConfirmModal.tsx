"use client";

// CONFIRM-01 #014：出荷準備開始ボタン押下時の確認ダイアログ
// 表示内容: ロック対象件数・注文一覧・同梱による追加・不可逆性提示
// ロック発動タイミング: 「出荷準備を開始する」ボタン押下完了時点（ダイアログ表示中はロックしない）

import type { Order } from "./OrderCard";

type Props = {
  /** スタッフが選択した注文（U2展開前） */
  selectedOrders: Order[];
  /** U2展開後の全ロック対象注文 */
  expandedOrders: Order[];
  /** 「出荷準備を開始する」押下時のコールバック。T5を実行する */
  onConfirm: () => void;
  /** 「戻る」押下時のコールバック。ダイアログを閉じ、状態変更なし */
  onClose: () => void;
  isConfirming: boolean;
  lockConditionReasons: string[];
};

const CARRIER_LABELS: Record<string, string> = {
  sagawa: "佐川急便",
  yamato: "ヤマト運輸",
  nekopos: "ネコポス",
};

export default function SessionLockConfirmModal({
  selectedOrders,
  expandedOrders,
  onConfirm,
  onClose,
  isConfirming,
  lockConditionReasons,
}: Props) {
  const selectedKeySet = new Set(selectedOrders.map((o) => o.unique_key));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col">
        {/* ヘッダー */}
        <div className="p-5 border-b">
          <h2 className="text-base font-bold text-gray-900">出荷準備を開始しますか？</h2>
        </div>

        {/* 本文（スクロール可） */}
        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          {/* ロック対象件数（CONFIRM-01 #1） */}
          <p className="text-sm font-medium text-gray-800">
            {expandedOrders.length}件の注文をロックします
          </p>

          {/* ロック対象注文一覧（CONFIRM-01 #2） */}
          <div>
            <p className="text-xs text-gray-500 mb-1.5">ロック対象注文一覧</p>
            <div className="border border-gray-200 rounded divide-y divide-gray-100 text-sm">
              {expandedOrders.map((order) => {
                const isAdded = !selectedKeySet.has(order.unique_key);
                return (
                  <div
                    key={order.unique_key}
                    className="px-3 py-2 flex items-center gap-2 flex-wrap"
                  >
                    <span className="font-mono text-xs text-gray-400 shrink-0">
                      {order.unique_key}
                    </span>
                    <span className="text-gray-900 flex-1 min-w-0 truncate">
                      {order.receiver_name}
                    </span>
                    <span className="text-xs text-gray-500 shrink-0">
                      {CARRIER_LABELS[order.carrier] ?? order.carrier}
                    </span>
                    {/* 同梱による追加（CONFIRM-01 §差分表示） */}
                    {isAdded && (
                      <span className="text-xs text-orange-700 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded shrink-0">
                        同梱のため追加
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 操作の不可逆性（CONFIRM-01 #3） */}
          <div className="bg-yellow-50 border border-yellow-200 rounded p-3">
            <p className="text-sm text-yellow-800">
              ロック後の変更には緊急解除が必要です
            </p>
          </div>
        </div>

        {/* フッターボタン */}
        <div className="p-4 border-t flex gap-3 justify-end">
          {/* 「戻る」: ダイアログを閉じる。状態変更なし（CONFIRM-01 確認操作） */}
          <button
            type="button"
            onClick={onClose}
            disabled={isConfirming}
            className="px-4 py-2 text-sm rounded border border-gray-300 text-gray-700
                       hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            戻る
          </button>
          {/* 「出荷準備を開始する」: 押下完了時点がロック発動タイミング（CONFIRM-01 補強レイヤー読替え） */}
          <button
            type="button"
            onClick={() => {
              if (lockConditionReasons.length > 0) return;
              onConfirm();
            }}
            disabled={isConfirming || lockConditionReasons.length > 0}
            className="px-4 py-2 text-sm rounded bg-blue-600 text-white font-medium
                       hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isConfirming ? "処理中..." : "出荷準備を開始する"}
          </button>
        </div>
      </div>
    </div>
  );
}

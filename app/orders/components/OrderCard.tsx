"use client";

import { useEffect, useState } from "react";
import OrderStatusBadge from "./OrderStatusBadge";
import BundleGroupIndicator from "./BundleGroupIndicator";

export type Order = {
  unique_key: string;
  receiver_name: string;
  order_date: string;
  shipping_method_name: string;
  shipping_fee: number;
  remark: string;
  item_count: number;
  items_summary: string;
  shipping_category: string;
  carrier: string;
  hold_flag: boolean;
  hold_reason: string;
  receipt_required: boolean;
  receipt_name: string;
  receipt_note: string;
  app_memo: string;
  cancelled_flag: boolean;
  bundle_group_id: string;
  bundle_order_unique_keys: string[];
  bundle_enabled: boolean;
  picking_status: "completed" | "in_progress" | "not_started";
  needs_initialization: boolean;
  has_multiple_shipping_lines: boolean;
  has_unknown_shipping_method: boolean;
  selectable_for_session: boolean;
  disabled_reason: string | null;
};

type Props = {
  order: Order;
  checked: boolean;
  onCheck: (uniqueKey: string, checked: boolean) => void;
  onRefresh: () => void;
};

export default function OrderCard({ order, checked, onCheck, onRefresh }: Props) {
  const bundleIdShort = order.bundle_group_id
    ? order.bundle_group_id.slice(0, 11) + "..."
    : "—";

  // 操作可否：needs_initialization または cancelled の場合は全UI無効
  const canEditU1 = !order.needs_initialization && !order.cancelled_flag;

  // ローカル状態（サーバーからの最新値と同期）
  const [localReceiptRequired, setLocalReceiptRequired] = useState(order.receipt_required);
  const [receiptName, setReceiptName] = useState(order.receipt_name);
  const [receiptNote, setReceiptNote] = useState(order.receipt_note);
  const [holdReason, setHoldReason] = useState(order.hold_reason);
  const [isSaving, setIsSaving] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);

  // order が更新されたらローカル状態をサーバー値に同期する
  useEffect(() => {
    setLocalReceiptRequired(order.receipt_required);
    setReceiptName(order.receipt_name);
    setReceiptNote(order.receipt_note);
    setHoldReason(order.hold_reason);
    setPatchError(null);
  }, [order]);

  // 共通PATCHヘルパー
  const patch = async (url: string, body: Record<string, unknown>): Promise<void> => {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json() as { error?: string };
      throw new Error(data.error ?? "更新に失敗しました");
    }
  };

  const withSave = async (fn: () => Promise<void>) => {
    if (isSaving) return;
    setIsSaving(true);
    setPatchError(null);
    try {
      await fn();
      onRefresh();
    } catch (e) {
      setPatchError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setIsSaving(false);
    }
  };

  // 配送業者 onChange
  const handleCarrierChange = (value: string) => {
    withSave(() => patch("/api/orders/carrier", { unique_key: order.unique_key, carrier: value }));
  };

  // 領収書チェックボックス onChange
  const handleReceiptCheckbox = (checked: boolean) => {
    setLocalReceiptRequired(checked);
    if (!checked) {
      // 未選択に戻す場合は即時保存
      withSave(() =>
        patch("/api/orders/receipt", {
          unique_key: order.unique_key,
          receipt_required: false,
          receipt_name: "",
          receipt_note: "",
        })
      );
    }
    // trueに変えた場合は入力欄を展開するだけ（保存ボタン押下まで待つ）
  };

  // 領収書 保存ボタン
  const handleReceiptSave = () => {
    withSave(() =>
      patch("/api/orders/receipt", {
        unique_key: order.unique_key,
        receipt_required: localReceiptRequired,
        receipt_name: receiptName,
        receipt_note: receiptNote,
      })
    );
  };

  // 保留にするボタン
  const handleHoldOn = () => {
    withSave(() =>
      patch("/api/orders/hold", { unique_key: order.unique_key, hold_flag: true, hold_reason: "" })
    );
  };

  // 保留理由 保存ボタン
  const handleHoldReasonSave = () => {
    withSave(() =>
      patch("/api/orders/hold", { unique_key: order.unique_key, hold_flag: true, hold_reason: holdReason })
    );
  };

  // 保留解除ボタン
  const handleHoldOff = () => {
    withSave(() =>
      patch("/api/orders/hold", { unique_key: order.unique_key, hold_flag: false, hold_reason: "" })
    );
  };

  return (
    <div className="border border-gray-200 rounded-lg bg-white shadow-sm p-4 flex gap-3">
      {/* チェックボックス列 */}
      <div className="flex flex-col items-center pt-0.5 min-w-[20px]">
        <input
          type="checkbox"
          className="w-4 h-4 accent-blue-600 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          checked={checked}
          disabled={!order.selectable_for_session}
          onChange={(e) => onCheck(order.unique_key, e.target.checked)}
          aria-label={`注文 ${order.unique_key} を選択`}
        />
      </div>

      {/* カード本体 */}
      <div className="flex-1 min-w-0">
        {/* ヘッダー行：氏名・注文日・ステータスバッジ */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-gray-900 text-sm">{order.receiver_name}</span>
          <span className="text-xs text-gray-500">{order.order_date}</span>
          <OrderStatusBadge
            needsInitialization={order.needs_initialization}
            hasMultipleShippingLines={order.has_multiple_shipping_lines}
            hasUnknownShippingMethod={order.has_unknown_shipping_method}
            cancelledFlag={order.cancelled_flag}
            holdFlag={order.hold_flag}
            shippingCategory={order.shipping_category}
            pickingStatus={order.picking_status}
          />
        </div>

        {/* 選択不可の理由 */}
        {!order.selectable_for_session && order.disabled_reason && (
          <p className="text-xs text-red-600 mt-0.5">{order.disabled_reason}</p>
        )}

        {/* 商品概要 */}
        <p className="text-sm text-gray-700 mt-1 truncate" title={order.items_summary}>
          {order.items_summary}
        </p>
        <p className="text-xs text-gray-500">{order.item_count}点</p>

        {/* 配送方法名 */}
        {order.shipping_method_name && (
          <p className="text-xs text-gray-600 mt-1">配送方法：{order.shipping_method_name}</p>
        )}

        {/* 備考（画面表示のみ） */}
        {order.remark && (
          <p className="text-xs text-gray-600 mt-1 truncate" title="備考">
            備考：{order.remark}
          </p>
        )}

        {/* 保留理由 */}
        {order.hold_flag && order.hold_reason && (
          <p className="text-xs text-yellow-700 mt-1">保留理由：{order.hold_reason}</p>
        )}

        {/* アプリメモ */}
        {order.app_memo && (
          <p className="text-xs text-blue-600 mt-1 flex items-center gap-1">
            <span aria-hidden>📝</span>
            {order.app_memo}
          </p>
        )}

        {/* PATCHエラー表示 */}
        {patchError && (
          <p className="text-xs text-red-600 mt-1">{patchError}</p>
        )}

        {/* 操作UI */}
        <div className="mt-3 flex flex-wrap items-start gap-4">
          {/* 配送業者選択 */}
          <div>
            <label className="text-xs text-gray-500 block mb-0.5">配送業者</label>
            <select
              value={order.carrier}
              disabled={!canEditU1 || isSaving}
              onChange={(e) => handleCarrierChange(e.target.value)}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">未選択</option>
              <option value="sagawa">佐川急便</option>
              <option value="yamato">ヤマト運輸</option>
              <option value="nekopos">ネコポス</option>
            </select>
          </div>

          {/* 領収書 */}
          <div>
            <div className="flex items-center gap-1.5">
              <input
                type="checkbox"
                id={`receipt-${order.unique_key}`}
                checked={localReceiptRequired}
                disabled={!canEditU1 || isSaving}
                onChange={(e) => handleReceiptCheckbox(e.target.checked)}
                className="w-4 h-4 accent-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <label
                htmlFor={`receipt-${order.unique_key}`}
                className="text-xs text-gray-600 cursor-pointer"
              >
                領収書
              </label>
            </div>

            {localReceiptRequired && (
              <div className="mt-1.5 flex flex-col gap-1">
                <input
                  type="text"
                  placeholder="宛名"
                  value={receiptName}
                  disabled={!canEditU1 || isSaving}
                  onChange={(e) => setReceiptName(e.target.value)}
                  className="text-xs border border-gray-300 rounded px-2 py-1 w-44
                             disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <input
                  type="text"
                  placeholder="但し書き"
                  value={receiptNote}
                  disabled={!canEditU1 || isSaving}
                  onChange={(e) => setReceiptNote(e.target.value)}
                  className="text-xs border border-gray-300 rounded px-2 py-1 w-44
                             disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <button
                  type="button"
                  disabled={!canEditU1 || isSaving}
                  onClick={handleReceiptSave}
                  className="text-xs px-2 py-1 rounded bg-blue-600 text-white
                             disabled:opacity-40 disabled:cursor-not-allowed self-start"
                >
                  保存
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 保留操作 */}
        <div className="mt-2">
          {!order.hold_flag ? (
            <button
              type="button"
              disabled={!canEditU1 || isSaving}
              onClick={handleHoldOn}
              className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              保留にする
            </button>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="保留理由"
                  value={holdReason}
                  disabled={!canEditU1 || isSaving}
                  onChange={(e) => setHoldReason(e.target.value)}
                  className="text-xs border border-yellow-300 rounded px-2 py-1 w-44
                             disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <button
                  type="button"
                  disabled={!canEditU1 || isSaving}
                  onClick={handleHoldReasonSave}
                  className="text-xs px-2 py-1 rounded border border-yellow-400 text-yellow-700
                             disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  保存
                </button>
              </div>
              <button
                type="button"
                disabled={!canEditU1 || isSaving}
                onClick={handleHoldOff}
                className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600
                           disabled:opacity-40 disabled:cursor-not-allowed self-start"
              >
                保留解除
              </button>
            </div>
          )}
        </div>

        {/* 同梱・バンドル情報 */}
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <BundleGroupIndicator
            bundleOrderUniqueKeys={order.bundle_order_unique_keys}
            bundleEnabled={order.bundle_enabled}
          />
          <span className="text-xs text-gray-400 font-mono" title={order.bundle_group_id}>
            {bundleIdShort}
          </span>
        </div>
      </div>
    </div>
  );
}

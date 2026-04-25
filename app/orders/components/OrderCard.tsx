"use client";

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
};

export default function OrderCard({ order, checked, onCheck }: Props) {
  const bundleIdShort = order.bundle_group_id
    ? order.bundle_group_id.slice(0, 11) + "..."
    : "—";

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

        {/* 操作 UI 枠（表示のみ・Step 4-A2 で書き込み実装） */}
        <div className="mt-3 flex flex-wrap items-end gap-4">
          {/* 配送業者選択 */}
          <div>
            <label className="text-xs text-gray-500 block mb-0.5">配送業者</label>
            <select
              value={order.carrier}
              onChange={() => { /* Step 4-A2で実装 */ }}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
            >
              <option value="">未選択</option>
              <option value="sagawa">佐川急便</option>
              <option value="yamato">ヤマト運輸</option>
              <option value="nekopos">ネコポス</option>
            </select>
          </div>

          {/* 領収書チェック */}
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              id={`receipt-${order.unique_key}`}
              checked={order.receipt_required}
              onChange={() => { /* Step 4-A2で実装 */ }}
              className="w-4 h-4 accent-blue-600"
            />
            <label htmlFor={`receipt-${order.unique_key}`} className="text-xs text-gray-600 cursor-pointer">
              領収書
            </label>
          </div>

          {/* 保留ボタン */}
          <button
            type="button"
            disabled
            onClick={() => { /* Step 4-A2で実装 */ }}
            className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-500
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {order.hold_flag ? "保留解除" : "保留にする"}
          </button>
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

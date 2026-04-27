"use client";

import { useCallback, useEffect, useState } from "react";
import OrderCard, { type Order } from "./components/OrderCard";
import SessionStatusBar from "./components/SessionStatusBar";
import DiffConfirmModal, { type DiffResult } from "./components/DiffConfirmModal";

type SessionInfo = {
  session_status: "none" | "active" | "unlocked" | "completed";
  locked_bundle_group_ids: string[];
  refetch_done_flag: boolean;
  diff_confirmed_flag: boolean;
};

type Meta = {
  total_order_count: number;
  uninitialized_count: number;
  unselectable_count: number;
};

type ApiResponse = {
  success: boolean;
  status: string;
  session: SessionInfo;
  orders: Order[];
  meta: Meta;
  error?: string;
};

type RefetchApiResponse = {
  success: boolean;
  diff_result?: DiffResult;
  error?: string;
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [session, setSession] = useState<SessionInfo>({
    session_status: "none",
    locked_bundle_group_ids: [],
    refetch_done_flag: false,
    diff_confirmed_flag: false,
  });
  const [meta, setMeta] = useState<Meta>({
    total_order_count: 0,
    uninitialized_count: 0,
    unselectable_count: 0,
  });
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // 再取得関連
  const [isRefetching, setIsRefetching] = useState(false);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);

  const fetchOrders = useCallback(async () => {
    const res = await fetch("/api/orders/list");
    const data = await res.json() as ApiResponse;
    if (!data.success) {
      setFetchError(data.error ?? "注文一覧の取得に失敗しました");
      return;
    }
    setOrders(data.orders);
    setSession(data.session);
    setMeta(data.meta);
  }, []);

  useEffect(() => {
    fetchOrders()
      .catch(() => setFetchError("ネットワークエラーが発生しました"))
      .finally(() => setLoading(false));
  }, [fetchOrders]);

  const handleCheck = (uniqueKey: string, checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(uniqueKey);
      else next.delete(uniqueKey);
      return next;
    });
  };

  /** 再取得ボタン押下 */
  const handleRefetch = async () => {
    setIsRefetching(true);
    try {
      const res = await fetch("/api/orders/refetch", { method: "POST" });
      const data = await res.json() as RefetchApiResponse;
      if (!data.success || !data.diff_result) {
        setFetchError(data.error ?? "再取得に失敗しました");
        return;
      }
      setDiffResult(data.diff_result);
    } catch {
      setFetchError("ネットワークエラーが発生しました");
    } finally {
      setIsRefetching(false);
    }
  };

  /** 差分確認完了後：モーダルを閉じ、注文一覧を再取得 */
  const handleDiffConfirmed = () => {
    setDiffResult(null);
    fetchOrders().catch(() => setFetchError("ネットワークエラーが発生しました"));
  };

  // 再取得ボタン表示条件（active中は非表示）
  const showRefetchButton = session.session_status !== "active";

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500 text-sm">読み込み中...</p>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-red-600 font-medium text-sm">{fetchError}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-3 text-sm text-blue-600 underline"
          >
            再読み込み
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* セッションステータスバー（画面上部固定） */}
      <div className="sticky top-0 z-10 shadow-sm">
        <SessionStatusBar
          sessionStatus={session.session_status}
          lockedBundleGroupIds={session.locked_bundle_group_ids}
          refetchDoneFlag={session.refetch_done_flag}
          diffConfirmedFlag={session.diff_confirmed_flag}
        />
      </div>

      <div className="max-w-3xl mx-auto px-4 py-4">
        {/* メタ情報バー */}
        <div className="flex items-center gap-4 mb-4 text-sm text-gray-600 flex-wrap">
          <span className="font-medium">注文一覧</span>
          <span>全 {meta.total_order_count} 件</span>
          {meta.unselectable_count > 0 && (
            <span className="text-orange-600">選択不可：{meta.unselectable_count} 件</span>
          )}
          {meta.uninitialized_count > 0 && (
            <span className="text-red-600">未初期化：{meta.uninitialized_count} 件</span>
          )}
          {selectedKeys.size > 0 && (
            <span className="text-blue-700 font-medium">選択中：{selectedKeys.size} 件</span>
          )}

          {/* 再取得ボタン */}
          {showRefetchButton && (
            <button
              type="button"
              disabled={isRefetching}
              onClick={handleRefetch}
              className="ml-auto text-sm px-3 py-1 rounded border border-blue-500 text-blue-600
                         bg-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRefetching ? "再取得中..." : "再取得する"}
            </button>
          )}
        </div>

        {/* 注文カード一覧 */}
        {orders.length > 0 ? (
          <div className="flex flex-col gap-3">
            {orders.map((order) => (
              <OrderCard
                key={order.unique_key}
                order={order}
                checked={selectedKeys.has(order.unique_key)}
                onCheck={handleCheck}
                onRefresh={fetchOrders}
              />
            ))}
          </div>
        ) : (
          <p className="text-center text-gray-500 py-16 text-sm">表示できる注文がありません</p>
        )}
      </div>

      {/* 差分確認モーダル */}
      {diffResult && (
        <DiffConfirmModal
          initialDiffResult={diffResult}
          onConfirmed={handleDiffConfirmed}
        />
      )}
    </div>
  );
}

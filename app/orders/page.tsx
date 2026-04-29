"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import OrderCard, { type Order } from "./components/OrderCard";
import SessionStatusBar from "./components/SessionStatusBar";
import DiffConfirmModal, { type DiffResult } from "./components/DiffConfirmModal";
import SessionLockConfirmModal from "./components/SessionLockConfirmModal";
import LockedStageView, { type LockedBundleInfo } from "./components/LockedStageView";

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

type OrdersApiResponse = {
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

type SessionCurrentApiResponse = {
  session: {
    session_id: string;
    session_status: string;
    locked_bundle_group_ids: string[];
    refetch_done_flag: boolean;
    diff_confirmed_flag: boolean;
    checklist_printed_flag: boolean;
    emergency_unlock_log: unknown[];
  } | null;
  locked_bundles?: LockedBundleInfo[];
  error?: string;
};

type SessionStartApiResponse = {
  success?: boolean;
  error?: string;
};

// UI側 U2展開（Step 4-B §4 展開手順①〜④）
// carrier・hold_flag の判定基準は「U2展開後のロック対象U1全件」
function expandByU2(
  selectedKeys: Set<string>,
  orders: Order[]
): { expandedOrders: Order[]; lockedBundleGroupIds: string[] } {
  if (selectedKeys.size === 0) {
    return { expandedOrders: [], lockedBundleGroupIds: [] };
  }

  // ② 各 unique_key の bundle_group_id を取得
  const selectedOrders = orders.filter((o) => selectedKeys.has(o.unique_key));
  const bgIdSet = new Set<string>();
  for (const o of selectedOrders) {
    if (o.bundle_group_id) bgIdSet.add(o.bundle_group_id);
  }

  // ③ bundle_group_id を重複排除
  const lockedBundleGroupIds = [...bgIdSet];

  // ④ 各U2の bundle_order_unique_keys を展開 → ロック対象U1全件
  const expandedKeySet = new Set<string>();
  for (const bgId of lockedBundleGroupIds) {
    // bundle_order_unique_keys は同一 bundle_group_id のいずれの注文からも同一の値を持つ
    const anyOrder = orders.find((o) => o.bundle_group_id === bgId);
    if (anyOrder) {
      for (const uk of anyOrder.bundle_order_unique_keys) {
        expandedKeySet.add(uk);
      }
    }
  }

  const expandedOrders = orders.filter((o) => expandedKeySet.has(o.unique_key));
  return { expandedOrders, lockedBundleGroupIds };
}

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
  const [isRefetching, setIsRefetching] = useState(false);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [lockedBundles, setLockedBundles] = useState<LockedBundleInfo[]>([]);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isStartingSession, setIsStartingSession] = useState(false);
  const [carrierErrorKeys, setCarrierErrorKeys] = useState<Set<string>>(new Set());

  const isLockedStage = session.session_status === "active";

  // 注文一覧を取得（BASE APIを叩く。セッションなし・完了・解除後に使用）
  const fetchOrdersList = useCallback(async () => {
    const res = await fetch("/api/orders/list");
    const data = (await res.json()) as OrdersApiResponse;
    if (!data.success) {
      setFetchError(data.error ?? "注文一覧の取得に失敗しました");
      return;
    }
    setOrders(data.orders);
    setSession(data.session);
    setMeta(data.meta);
  }, []);

  // セッション状態を取得（BASE APIを叩かない。active時は locked_bundles も取得）
  const fetchCurrentSession = useCallback(async (): Promise<boolean> => {
    const res = await fetch("/api/session/current");
    const data = (await res.json()) as SessionCurrentApiResponse;
    if (data.error) {
      setFetchError(data.error);
      return false;
    }
    if (data.session?.session_status === "active") {
      setSession({
        session_status: "active",
        locked_bundle_group_ids: data.session.locked_bundle_group_ids,
        refetch_done_flag: data.session.refetch_done_flag,
        diff_confirmed_flag: data.session.diff_confirmed_flag,
      });
      setLockedBundles(data.locked_bundles ?? []);
      return true;
    }
    return false;
  }, []);

  // ページ初期ロード: active なら LockedStageView、そうでなければ注文一覧
  const loadPage = useCallback(async () => {
    const isActive = await fetchCurrentSession();
    if (!isActive) {
      await fetchOrdersList();
    }
  }, [fetchCurrentSession, fetchOrdersList]);

  useEffect(() => {
    loadPage()
      .catch(() => setFetchError("ネットワークエラーが発生しました"))
      .finally(() => setLoading(false));
  }, [loadPage]);

  const handleCarrierError = (uniqueKey: string, hasError: boolean) => {
    setCarrierErrorKeys((prev) => {
      const next = new Set(prev);
      if (hasError) {
        next.add(uniqueKey);
      } else {
        next.delete(uniqueKey);
      }
      return next;
    });
  };

  const handleCheck = (uniqueKey: string, checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(uniqueKey);
      else next.delete(uniqueKey);
      return next;
    });
  };

  const handleRefetch = async () => {
    setIsRefetching(true);
    try {
      const res = await fetch("/api/orders/refetch", { method: "POST" });
      const data = (await res.json()) as RefetchApiResponse;
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

  const handleDiffConfirmed = () => {
    setDiffResult(null);
    fetchOrdersList().catch(() => setFetchError("ネットワークエラーが発生しました"));
  };

  // UI側 U2展開（§4 展開手順）
  const { expandedOrders, lockedBundleGroupIds: _lockedBgIds } = useMemo(
    () => expandByU2(selectedKeys, orders),
    [selectedKeys, orders]
  );
  void _lockedBgIds; // API側で展開するため UI側の lockedBundleGroupIds は参照のみ

  // ボタン活性条件チェック（U2〜U5。U6=picking_status は一時除外・UIへの表示なし）
  // carrier・hold_flag の判定基準は「U2展開後のロック対象U1全件」（§9）
  const lockConditionReasons = useMemo(() => {
    const reasons: string[] = [];
    if (selectedKeys.size === 0) return reasons;
    if (!session.refetch_done_flag) reasons.push("再取得が未完了です");
    if (!session.diff_confirmed_flag) reasons.push("差分確認が未完了です");
    const hasCarrierError = expandedOrders.some((o) => carrierErrorKeys.has(o.unique_key));
    if (expandedOrders.some((o) => !o.carrier) || hasCarrierError) {
      reasons.push("ロック対象に配送業者が未選択の注文があります");
    }
    if (expandedOrders.some((o) => o.hold_flag)) {
      reasons.push("ロック対象に保留中の注文が含まれています");
    }
    return reasons;
  }, [selectedKeys, session.refetch_done_flag, session.diff_confirmed_flag, expandedOrders, carrierErrorKeys]);

  const canStartSession = selectedKeys.size > 0 && lockConditionReasons.length === 0;

  const handleStartSession = () => {
    if (lockConditionReasons.length > 0) return;
    setShowConfirmModal(true);
  };

  // 確認モーダル「出荷準備を開始する」押下時: T5を実行する（CONFIRM-01 #014）
  const handleConfirmStart = async () => {
    setIsStartingSession(true);
    try {
      const res = await fetch("/api/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected_unique_keys: [...selectedKeys] }),
      });
      const data = (await res.json()) as SessionStartApiResponse;
      if (!res.ok || !data.success) {
        setFetchError(data.error ?? "セッション開始に失敗しました");
        setShowConfirmModal(false);
        return;
      }
      // T5実行成功: LockedStageView へ遷移
      setShowConfirmModal(false);
      setSelectedKeys(new Set());
      await fetchCurrentSession();
    } catch {
      setFetchError("ネットワークエラーが発生しました");
      setShowConfirmModal(false);
    } finally {
      setIsStartingSession(false);
    }
  };

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

      {isLockedStage ? (
        // ロック後ステージ（session_status === "active"）
        <LockedStageView lockedBundles={lockedBundles} />
      ) : (
        // ロック前ステージ（注文一覧・選択UI）
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

            {/* 再取得ボタン（active中は非表示） */}
            <button
              type="button"
              disabled={isRefetching}
              onClick={handleRefetch}
              className="ml-auto text-sm px-3 py-1 rounded border border-blue-500 text-blue-600
                         bg-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRefetching ? "再取得中..." : "再取得する"}
            </button>
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
                  onRefresh={fetchOrdersList}
                  onCarrierError={(hasError) => handleCarrierError(order.unique_key, hasError)}
                />
              ))}
            </div>
          ) : (
            <p className="text-center text-gray-500 py-16 text-sm">
              表示できる注文がありません
            </p>
          )}

          {/* 出荷準備開始エリア（選択済みの場合のみ表示） */}
          {selectedKeys.size > 0 && (
            <div className="mt-6 p-4 bg-white border border-gray-200 rounded-lg shadow-sm">
              {/* 未充足条件の一覧表示（複数ある場合は全て列挙） */}
              {lockConditionReasons.length > 0 && (
                <ul className="mb-3 space-y-1">
                  {lockConditionReasons.map((reason) => (
                    <li key={reason} className="text-sm text-red-600 flex items-start gap-1">
                      <span aria-hidden className="shrink-0">・</span>
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                disabled={!canStartSession}
                onClick={handleStartSession}
                className="w-full py-2.5 text-sm font-medium rounded
                           bg-blue-600 text-white hover:bg-blue-700
                           disabled:opacity-40 disabled:cursor-not-allowed"
              >
                出荷準備を開始する
              </button>
            </div>
          )}
        </div>
      )}

      {/* 差分確認モーダル */}
      {diffResult && (
        <DiffConfirmModal
          initialDiffResult={diffResult}
          onConfirmed={handleDiffConfirmed}
        />
      )}

      {/* セッションロック確認モーダル（CONFIRM-01 #014） */}
      {showConfirmModal && (
        <SessionLockConfirmModal
          selectedOrders={orders.filter((o) => selectedKeys.has(o.unique_key))}
          expandedOrders={expandedOrders}
          onConfirm={handleConfirmStart}
          onClose={() => setShowConfirmModal(false)}
          isConfirming={isStartingSession}
          lockConditionReasons={lockConditionReasons}
        />
      )}
    </div>
  );
}

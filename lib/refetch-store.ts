// orders:refetch_state（固定キー）の読み書き管理
// 再取得・差分確認フラグの永続化（Step 4-A3）

import { redis } from "@/lib/upstash";
import { fencedMutate, type WorkflowLease } from "@/lib/workflow-operation-lease";
import type {
  CancellationState,
  GenerationIssueCode,
} from "@/lib/pdf-order-assessment";

export const REFETCH_STATE_KEY = "orders:refetch_state";

export type RefetchPhase =
  | "awaiting_initialization"
  | "awaiting_review"
  | "promoting"
  | "postprocessing"
  | "confirmed";

export type RefetchState = {
  refetch_done_flag: boolean;
  diff_confirmed_flag: boolean;
  refetched_at: string | null;   // ISO 8601。resetRefetchState()時はnull
  has_new_uninitialized: boolean;
  refetch_cycle_id?: string;
  refetch_result?: "complete" | "partial";
  order_results?: Record<string, RefetchOrderResult>;
  phase?: RefetchPhase;
  new_uninitialized_count?: number;
  post_init_refetch_ready?: boolean;
};

export type RefetchOrderResult = {
  status:
    | "verified_eligible"
    | "verified_blocked"
    | "fetch_failed"
    | "not_in_open_orders";
  cancellation_state?: CancellationState;
  issues: GenerationIssueCode[];
};

/** 現在の再取得状態を取得する。キーが存在しない場合はnullを返す */
export async function getRefetchState(): Promise<RefetchState | null> {
  const raw = await redis.get<string | RefetchState>(REFETCH_STATE_KEY);
  if (!raw) return null;
  if (typeof raw === "string") return JSON.parse(raw) as RefetchState;
  return raw;
}

/** 再取得状態を保存する */
export async function setRefetchState(state: RefetchState): Promise<void> {
  await redis.set(REFETCH_STATE_KEY, JSON.stringify(state));
}

export async function setRefetchStateFenced(
  lease: WorkflowLease,
  state: RefetchState
): Promise<void> {
  await fencedMutate(lease, [
    { type: "set", key: REFETCH_STATE_KEY, value: JSON.stringify(state) },
  ]);
}

/** 再取得状態を初期値でリセットする。POST /api/orders/refetch 冒頭で呼ぶ */
export async function resetRefetchState(refetchCycleId?: string): Promise<void> {
  const initial: RefetchState = {
    refetch_done_flag: false,
    diff_confirmed_flag: false,
    refetched_at: null,
    has_new_uninitialized: false,
    refetch_cycle_id: refetchCycleId,
    order_results: {},
  };
  await redis.set(REFETCH_STATE_KEY, JSON.stringify(initial));
}

export function createInitialRefetchState(
  refetchCycleId: string
): RefetchState {
  return {
    refetch_done_flag: false,
    diff_confirmed_flag: false,
    refetched_at: null,
    has_new_uninitialized: false,
    refetch_cycle_id: refetchCycleId,
    phase: "awaiting_review",
    new_uninitialized_count: 0,
    order_results: {},
  };
}

/** orders:refetch_state を削除する。T5（session/start）でU3へコピー完了後に呼ぶ */
export async function deleteRefetchState(): Promise<void> {
  await redis.del(REFETCH_STATE_KEY);
}

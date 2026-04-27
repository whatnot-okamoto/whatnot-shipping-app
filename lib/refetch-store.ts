// orders:refetch_state（固定キー）の読み書き管理
// 再取得・差分確認フラグの永続化（Step 4-A3）

import { redis } from "@/lib/upstash";

const KEY = "orders:refetch_state";

export type RefetchState = {
  refetch_done_flag: boolean;
  diff_confirmed_flag: boolean;
  refetched_at: string | null;   // ISO 8601。resetRefetchState()時はnull
  has_new_uninitialized: boolean;
};

/** 現在の再取得状態を取得する。キーが存在しない場合はnullを返す */
export async function getRefetchState(): Promise<RefetchState | null> {
  const raw = await redis.get<string | RefetchState>(KEY);
  if (!raw) return null;
  if (typeof raw === "string") return JSON.parse(raw) as RefetchState;
  return raw;
}

/** 再取得状態を保存する */
export async function setRefetchState(state: RefetchState): Promise<void> {
  await redis.set(KEY, JSON.stringify(state));
}

/** 再取得状態を初期値でリセットする。POST /api/orders/refetch 冒頭で呼ぶ */
export async function resetRefetchState(): Promise<void> {
  const initial: RefetchState = {
    refetch_done_flag: false,
    diff_confirmed_flag: false,
    refetched_at: null,
    has_new_uninitialized: false,
  };
  await redis.set(KEY, JSON.stringify(initial));
}

/** orders:refetch_state を削除する。T5（session/start）でU3へコピー完了後に呼ぶ */
export async function deleteRefetchState(): Promise<void> {
  await redis.del(KEY);
}

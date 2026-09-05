export type OrderListSortItem = {
  unique_key: string;
  ordered_timestamp: number;
};

export function isValidOrderedTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * 一覧表示時に取得したBASEのorderedを正とする。
 * BASE値が異常な場合だけ保存済みsnapshotへフォールバックし、
 * どちらにも正確な時刻がなければ0として一覧末尾へ送る。
 */
export function resolveOrderedTimestamp(
  baseOrdered: unknown,
  snapshotOrdered: unknown
): number {
  if (isValidOrderedTimestamp(baseOrdered)) return baseOrdered;
  if (isValidOrderedTimestamp(snapshotOrdered)) return snapshotOrdered;
  return 0;
}

/** ordered降順。同一秒はunique_key昇順で決定論的に並べる。 */
export function compareOrdersNewestFirst<T extends OrderListSortItem>(
  a: T,
  b: T
): number {
  if (a.ordered_timestamp !== b.ordered_timestamp) {
    return b.ordered_timestamp - a.ordered_timestamp;
  }
  if (a.unique_key === b.unique_key) return 0;
  return a.unique_key < b.unique_key ? -1 : 1;
}

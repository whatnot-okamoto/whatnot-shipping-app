import { redis } from "@/lib/upstash";
import {
  buildPromotedOrderSnapshot,
  getStaffReviewSnapshotChanges,
} from "@/lib/order-snapshot-diff";
import type { OrderSnapshot } from "@/lib/order-store";
import {
  getRefetchState,
  setRefetchStateFenced,
  type RefetchOrderResult,
  type RefetchState,
} from "@/lib/refetch-store";
import { clearPdfOutputDoneFlagFenced } from "@/lib/session-store";
import {
  DIFF_CONFIRM_CHUNK_SIZE,
  fencedMutate,
  renewWorkflowLeaseIfDue,
  type WorkflowLease,
} from "@/lib/workflow-operation-lease";

const PENDING_INDEX_KEY = "index:order_snapshot_pending";

function parseRedisValue<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return JSON.parse(raw) as T;
  return raw as T;
}

type PendingPair = {
  uniqueKey: string;
  snapshot: OrderSnapshot | null;
  pending: OrderSnapshot | null;
  indexed: boolean;
  orderResultStatus: RefetchOrderResult["status"] | null;
};

async function readPendingPairs(
  uniqueKeys: string[],
  options?: {
    indexedKeys?: Set<string>;
    orderResults?: RefetchState["order_results"];
  }
): Promise<PendingPair[]> {
  if (uniqueKeys.length === 0) return [];
  const indexedKeys = options?.indexedKeys ?? new Set(uniqueKeys);
  const pipeline = redis.pipeline();
  for (const uniqueKey of uniqueKeys) {
    pipeline.get(`order_snapshot:${uniqueKey}`);
    pipeline.get(`order_snapshot_pending:${uniqueKey}`);
  }
  const results = await pipeline.exec();
  return uniqueKeys.map((uniqueKey, index) => ({
    uniqueKey,
    snapshot: parseRedisValue<OrderSnapshot>(results[index * 2]),
    pending: parseRedisValue<OrderSnapshot>(results[index * 2 + 1]),
    indexed: indexedKeys.has(uniqueKey),
    orderResultStatus: options?.orderResults?.[uniqueKey]?.status ?? null,
  }));
}

async function readRecoveryPairs(
  indexedKeys: string[],
  state: RefetchState
): Promise<PendingPair[]> {
  const successfulResultKeys = Object.entries(state.order_results ?? {}).flatMap(
    ([uniqueKey, result]) => result.status === "fetch_failed" ? [] : [uniqueKey]
  );
  const uniqueKeys = [...new Set([...indexedKeys, ...successfulResultKeys])];
  return readPendingPairs(uniqueKeys, {
    indexedKeys: new Set(indexedKeys),
    orderResults: state.order_results,
  });
}

export type DiffRecoveryReview = {
  refetch_cycle_id: string;
  phase: RefetchState["phase"] | "legacy";
  review_status: "fresh" | "resuming_partial" | "conflict" | "confirmed";
  can_confirm: boolean;
  can_initialize: boolean;
  processed_details_fully_recoverable: boolean;
  diff_confirmed_flag: boolean;
  remaining_diff_count: number;
  remaining_diff_summary: DiffRecoveryItem[];
  first_absence_count: number;
  cycle_not_in_open_orders_count: number;
  new_uninitialized_count: number | null;
  resolved_uninitialized_cycle_id: string | null;
  resolved_uninitialized_count: number | null;
  resolved_uninitialized_reason: "not_in_current_open_orders" | null;
  resolved_uninitialized_checked_at: string | null;
  has_fetch_failures: boolean;
  failed_unique_keys: string[];
  details_recovery: "full" | "remaining_only" | "none";
  message: string;
};

export function canInitializeDiffReview(
  review: Pick<
    DiffRecoveryReview,
    | "refetch_cycle_id"
    | "phase"
    | "review_status"
    | "can_confirm"
    | "new_uninitialized_count"
  >,
  requestedCycleId: string = review.refetch_cycle_id
): boolean {
  return (
    review.refetch_cycle_id === requestedCycleId &&
    review.phase === "awaiting_initialization" &&
    review.review_status === "fresh" &&
    review.can_confirm === false &&
    Number.isSafeInteger(review.new_uninitialized_count) &&
    Number(review.new_uninitialized_count) > 0
  );
}

type ResolvedUninitializedAudit = {
  cycleId: string;
  count: number;
  reason: "not_in_current_open_orders";
  checkedAt: string;
};

function readResolvedUninitializedAudit(
  state: RefetchState
): { audit: ResolvedUninitializedAudit | null; malformed: boolean } {
  const hasAnyField =
    state.resolved_uninitialized_cycle_id !== undefined ||
    state.resolved_uninitialized_count !== undefined ||
    state.resolved_uninitialized_reason !== undefined ||
    state.resolved_uninitialized_checked_at !== undefined;
  if (!hasAnyField) return { audit: null, malformed: false };
  if (
    typeof state.resolved_uninitialized_cycle_id !== "string" ||
    state.resolved_uninitialized_cycle_id.length === 0 ||
    !Number.isSafeInteger(state.resolved_uninitialized_count) ||
    Number(state.resolved_uninitialized_count) <= 0 ||
    state.resolved_uninitialized_reason !== "not_in_current_open_orders" ||
    typeof state.resolved_uninitialized_checked_at !== "string" ||
    state.resolved_uninitialized_checked_at.length === 0
  ) {
    return { audit: null, malformed: true };
  }
  return {
    audit: {
      cycleId: state.resolved_uninitialized_cycle_id,
      count: Number(state.resolved_uninitialized_count),
      reason: state.resolved_uninitialized_reason,
      checkedAt: state.resolved_uninitialized_checked_at,
    },
    malformed: false,
  };
}

export type DiffRecoveryItem = {
  unique_key: string;
  diff_type: "item_changed" | "fee_changed" | "other";
  description: string;
  severity: "info" | "warning";
};

function buildRemainingItem(
  pair: PendingPair,
  cycleId: string
): DiffRecoveryItem | null {
  if (!pair.indexed) return null;
  if (!pair.snapshot || !pair.pending) return null;
  if (pair.pending.pdf_verification_cycle_id !== cycleId) return null;
  if (pair.pending.open_order_presence === "not_in_open_orders") return null;
  const changes = getStaffReviewSnapshotChanges(pair.snapshot, pair.pending);
  if (changes.itemChanged) {
    return {
      unique_key: pair.uniqueKey,
      diff_type: "item_changed",
      description: "商品内容が変更されました",
      severity: "warning",
    };
  }
  if (changes.feeChanged) {
    return {
      unique_key: pair.uniqueKey,
      diff_type: "fee_changed",
      description: "送料が変更されました",
      severity: "info",
    };
  }
  if (changes.shippingChanged) {
    return {
      unique_key: pair.uniqueKey,
      diff_type: "other",
      description: "配送情報が変更されました",
      severity: "info",
    };
  }
  return null;
}

type RecoveryClassification = {
  reviewStatus: DiffRecoveryReview["review_status"];
  canConfirm: boolean;
  processedDetailsFullyRecoverable: boolean;
  detailsRecovery: DiffRecoveryReview["details_recovery"];
  message: string;
};

function classifyRecoveryState(
  state: RefetchState,
  pairs: PendingPair[]
): RecoveryClassification {
  const cycleId = state.refetch_cycle_id;
  const hasUnsafePair =
    !cycleId ||
    pairs.some(({ snapshot, pending, indexed, orderResultStatus }) => {
      if (!pending) {
        if (!snapshot) {
          return indexed || orderResultStatus !== "not_in_open_orders";
        }
        return snapshot.pdf_verification_cycle_id !== cycleId;
      }
      return (
        !indexed ||
        pending.pdf_verification_cycle_id !== cycleId ||
        snapshot === null
      );
    });
  const hasPendingWork = pairs.some(
    ({ pending, indexed }) => pending !== null || indexed
  );
  const isConfirmedComplete =
    state.phase === "confirmed" &&
    state.diff_confirmed_flag === true &&
    !hasPendingWork;

  if (!hasUnsafePair && isConfirmedComplete) {
    return {
      reviewStatus: "confirmed",
      canConfirm: false,
      processedDetailsFullyRecoverable: false,
      detailsRecovery: "none",
      message: "今回の差分確認は完了しています。",
    };
  }

  const phaseContradiction =
    (state.phase === "postprocessing" && hasPendingWork) ||
    state.phase === "confirmed" ||
    (state.diff_confirmed_flag === true && state.phase !== undefined) ||
    state.refetch_done_flag !== true;

  if (hasUnsafePair || phaseContradiction) {
    return {
      reviewStatus: "conflict",
      canConfirm: false,
      processedDetailsFullyRecoverable: false,
      detailsRecovery: "none",
      message:
        "保存されている差分情報と注文状態の整合性を安全に確認できないため、この画面では初期化・差分確認を実行できません。操作せず管理者へ連絡してください。",
    };
  }

  const hasProcessedPair = pairs.some(
    ({ snapshot, pending }) =>
      snapshot?.pdf_verification_cycle_id === cycleId &&
      (pending === null || pending.pdf_verification_cycle_id === cycleId)
  );
  const isResuming =
    hasProcessedPair ||
    state.phase === "promoting" ||
    state.phase === "postprocessing" ||
    (state.phase === undefined && state.diff_confirmed_flag === true);
  if (isResuming) {
    return {
      reviewStatus: "resuming_partial",
      canConfirm: state.has_new_uninitialized !== true,
      processedDetailsFullyRecoverable: false,
      detailsRecovery: "remaining_only",
      message:
        "以前の確認処理が途中まで進んでいます。削除済みの差分詳細は完全復元できないため、残りの差分と再開状態を表示しています。",
    };
  }

  return {
    reviewStatus: "fresh",
    canConfirm: state.has_new_uninitialized !== true,
    processedDetailsFullyRecoverable: true,
    detailsRecovery: "full",
    message: "今回の再取得で検出した差分を表示しています。",
  };
}

export async function getDiffRecoveryReview(): Promise<DiffRecoveryReview | null> {
  const state = await getRefetchState();
  if (!state?.refetch_cycle_id) return null;
  const keys = await redis.smembers(PENDING_INDEX_KEY);
  const pairs = await readRecoveryPairs(keys, state);
  let classification = classifyRecoveryState(state, pairs);
  const resolvedAudit = readResolvedUninitializedAudit(state);
  if (resolvedAudit.malformed) {
    classification = {
      reviewStatus: "conflict",
      canConfirm: false,
      processedDetailsFullyRecoverable: false,
      detailsRecovery: "none",
      message:
        "未初期化注文の確認履歴を安全に復元できません。確認ボタンを押さず、管理者へ連絡してください。",
    };
  }
  const firstAbsenceCount =
    typeof state.first_absence_count === "number"
      ? state.first_absence_count
      : pairs.filter(
          ({ snapshot, pending }) =>
            pending?.pdf_verification_cycle_id === state.refetch_cycle_id &&
            pending?.open_order_presence === "not_in_open_orders" &&
            snapshot?.open_order_presence !== "not_in_open_orders"
        ).length;
  const remainingDiffSummary = pairs.flatMap((pair) => {
    const item = buildRemainingItem(pair, state.refetch_cycle_id!);
    return item ? [item] : [];
  });
  const failedUniqueKeys = Object.entries(state.order_results ?? {}).flatMap(
    ([uniqueKey, result]) =>
      result.status === "fetch_failed" ? [uniqueKey] : []
  );
  const recoveredFetchFailureItems: DiffRecoveryItem[] = failedUniqueKeys.map(
    (uniqueKey) => ({
      unique_key: uniqueKey,
      diff_type: "other",
      description:
        "注文詳細を取得できませんでした。この注文は今回の選択対象から外れます",
      severity: "warning",
    })
  );
  const combinedSummary = [...remainingDiffSummary, ...recoveredFetchFailureItems];
  const cycleNotInOpenOrdersCount = Object.values(state.order_results ?? {}).filter(
    (result) => result.status === "not_in_open_orders"
  ).length;
  const newUninitializedCount =
    typeof state.new_uninitialized_count === "number"
      ? state.new_uninitialized_count
      : state.has_new_uninitialized
        ? null
        : 0;
  const review: DiffRecoveryReview = {
    refetch_cycle_id: state.refetch_cycle_id,
    phase: state.phase ?? "legacy",
    review_status: classification.reviewStatus,
    can_confirm: classification.canConfirm,
    can_initialize: false,
    processed_details_fully_recoverable:
      classification.processedDetailsFullyRecoverable,
    diff_confirmed_flag: state.diff_confirmed_flag,
    remaining_diff_count: combinedSummary.length,
    remaining_diff_summary: combinedSummary,
    first_absence_count: firstAbsenceCount,
    cycle_not_in_open_orders_count: cycleNotInOpenOrdersCount,
    new_uninitialized_count: newUninitializedCount,
    resolved_uninitialized_cycle_id: resolvedAudit.audit?.cycleId ?? null,
    resolved_uninitialized_count: resolvedAudit.audit?.count ?? null,
    resolved_uninitialized_reason: resolvedAudit.audit?.reason ?? null,
    resolved_uninitialized_checked_at: resolvedAudit.audit?.checkedAt ?? null,
    has_fetch_failures: failedUniqueKeys.length > 0,
    failed_unique_keys: failedUniqueKeys,
    details_recovery: classification.detailsRecovery,
    message: classification.message,
  };
  review.can_initialize = canInitializeDiffReview(review);
  return review;
}

export type ConfirmDiffResult =
  | { status: "confirmed"; already_complete: boolean }
  | { status: "not_ready"; message: string }
  | { status: "initialization_required"; message: string }
  | { status: "cycle_mismatch"; message: string }
  | { status: "unsafe_recovery"; message: string };

function isCurrentCycle(snapshot: OrderSnapshot, cycleId: string): boolean {
  return snapshot.pdf_verification_cycle_id === cycleId;
}

export async function confirmDiffCycle(
  requestedCycleId: string,
  lease: WorkflowLease
): Promise<ConfirmDiffResult> {
  let state = await getRefetchState();
  if (!state || state.refetch_done_flag !== true) {
    return { status: "not_ready", message: "再取得が完了していません。" };
  }
  if (!state.refetch_cycle_id || state.refetch_cycle_id !== requestedCycleId) {
    return { status: "cycle_mismatch", message: "再取得cycleが一致しません。" };
  }
  if (state.has_new_uninitialized) {
    return {
      status: "initialization_required",
      message: "未初期化注文があります。初期化後に再取得してください。",
    };
  }

  let pendingKeys = await redis.smembers(PENDING_INDEX_KEY);
  if (state.phase === "postprocessing" && pendingKeys.length > 0) {
    return {
      status: "unsafe_recovery",
      message:
        "後処理状態とpendingが一致しないため、自動変更を停止しました。",
    };
  }
  if (
    state.phase === "confirmed" &&
    state.diff_confirmed_flag === true &&
    pendingKeys.length === 0
  ) {
    await fencedMutate(lease, []);
    return { status: "confirmed", already_complete: true };
  }
  if (
    state.phase === undefined &&
    state.diff_confirmed_flag === true &&
    pendingKeys.length === 0
  ) {
    state = { ...state, phase: "postprocessing", diff_confirmed_flag: false };
    await setRefetchStateFenced(lease, state);
  } else if (state.phase === "confirmed" || state.diff_confirmed_flag === true) {
    return {
      status: "unsafe_recovery",
      message: "完了状態とpendingが一致しないため、自動変更を停止しました。",
    };
  }

  if (state.phase !== "postprocessing") {
    // Legacy route recovery: validate the entire indexed set before the first
    // write. Any unknown/old-cycle orphan stops with zero mutations.
    const pairs = await readPendingPairs(pendingKeys);
    const unsafe = pairs.find(({ snapshot, pending }) => {
      if (!pending) return !snapshot || !isCurrentCycle(snapshot, requestedCycleId);
      if (!isCurrentCycle(pending, requestedCycleId)) return true;
      return !snapshot;
    });
    if (unsafe) {
      return {
        status: "unsafe_recovery",
        message: `復旧可否を安全に判定できないpendingがあります: ${unsafe.uniqueKey}`,
      };
    }

    state = { ...state, phase: "promoting", diff_confirmed_flag: false };
    await setRefetchStateFenced(lease, state);

    for (let offset = 0; offset < pairs.length; offset += DIFF_CONFIRM_CHUNK_SIZE) {
      await renewWorkflowLeaseIfDue(lease);
      const chunk = pairs.slice(offset, offset + DIFF_CONFIRM_CHUNK_SIZE);
      const mutations = [];
      for (const { uniqueKey, snapshot, pending } of chunk) {
        if (pending && snapshot && !isCurrentCycle(snapshot, requestedCycleId)) {
          const promoted = buildPromotedOrderSnapshot(snapshot, pending);
          if (promoted) {
            mutations.push({
              type: "set" as const,
              key: `order_snapshot:${uniqueKey}`,
              value: JSON.stringify(promoted),
            });
          }
        }
        if (pending) {
          mutations.push({
            type: "del" as const,
            keys: [`order_snapshot_pending:${uniqueKey}`],
          });
        }
      }
      if (chunk.length > 0) {
        mutations.push({
          type: "srem" as const,
          key: PENDING_INDEX_KEY,
          members: chunk.map(({ uniqueKey }) => uniqueKey),
        });
      }
      await fencedMutate(lease, mutations);
    }

    pendingKeys = await redis.smembers(PENDING_INDEX_KEY);
    if (pendingKeys.length > 0) {
      return {
        status: "unsafe_recovery",
        message: "pending処理が完了していないため後処理へ進みません。",
      };
    }
    state = { ...state, phase: "postprocessing", diff_confirmed_flag: false };
    await setRefetchStateFenced(lease, state);
  }

  await clearPdfOutputDoneFlagFenced(lease);
  await setRefetchStateFenced(lease, {
    ...state,
    phase: "confirmed",
    diff_confirmed_flag: true,
  });
  return { status: "confirmed", already_complete: false };
}

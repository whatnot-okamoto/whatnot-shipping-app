import { redis } from '@/lib/upstash';
import { getOrderSnapshots, type OrderSnapshot } from './order-store';
import { getStaffReviewSnapshotChanges } from './order-snapshot-diff';
import { readWorkflowContext, assertPublishedContext, contextGuards, pendingKey, pendingIndexKey,
  workflowFingerprint, setRefetchStateFenced, type RefetchState } from './refetch-store';
import { renewWorkflowLeaseIfDue, DIFF_CONFIRM_CHUNK_SIZE, fencedMutate, type WorkflowLease } from './workflow-operation-lease';

export type DiffRecoveryItem = { unique_key: string; diff_type: 'item_changed' | 'fee_changed' | 'other';
  description: string; severity: 'info' | 'warning' };
export type DiffRecoveryReview = {
  refetch_cycle_id: string; phase: RefetchState['phase'] | 'legacy';
  review_status: 'fresh' | 'resuming_partial' | 'conflict' | 'confirmed';
  can_confirm: boolean; can_initialize: boolean; has_new_uninitialized: boolean;
  processed_details_fully_recoverable: boolean; diff_confirmed_flag: boolean;
  remaining_diff_count: number; remaining_diff_summary: DiffRecoveryItem[];
  first_absence_count: number; cycle_not_in_open_orders_count: number; new_uninitialized_count: number | null;
  resolved_uninitialized_cycle_id: string | null; resolved_uninitialized_count: number | null;
  resolved_uninitialized_reason: 'not_in_current_open_orders' | null; resolved_uninitialized_checked_at: string | null;
  has_fetch_failures: boolean; failed_unique_keys: string[]; details_recovery: 'full' | 'remaining_only' | 'none'; message: string;
};
export function canInitializeDiffReview(review: Pick<DiffRecoveryReview,
  'refetch_cycle_id' | 'phase' | 'review_status' | 'can_confirm' | 'has_new_uninitialized' | 'new_uninitialized_count'>,
  requestedCycleId = review.refetch_cycle_id): boolean {
  return review.refetch_cycle_id === requestedCycleId && review.phase === 'awaiting_initialization' &&
    review.review_status === 'fresh' && !review.can_confirm && review.has_new_uninitialized === true &&
    Number.isSafeInteger(review.new_uninitialized_count) && Number(review.new_uninitialized_count) > 0;
}
type Pair = { id: string; current: OrderSnapshot | null; pending: OrderSnapshot | null; done: boolean };
async function readPairs(state: RefetchState) {
  const epoch = state.workflow_epoch!;
  const manifest = state.confirmation_manifest;
  if (!manifest || !state.current_order_keys || Object.keys(manifest).length > 100) throw new Error('M1_MANIFEST');
  const raw = await redis.getRawString(pendingIndexKey(epoch), 32 * 1024);
  if (!raw) throw new Error('M1_INDEX_MISSING');
  const index = JSON.parse(raw) as { schema_version: number; workflow_epoch: string; refetch_cycle_id: string; keys: string[] };
  if (index.schema_version !== 1 || index.workflow_epoch !== epoch || index.refetch_cycle_id !== state.refetch_cycle_id ||
      !Array.isArray(index.keys) || new Set(index.keys).size !== index.keys.length ||
      index.keys.some(id => !Object.hasOwn(manifest, id))) throw new Error('M1_INDEX_MISMATCH');
  const ids = Object.keys(manifest);
  const snapshots = await getOrderSnapshots(ids);
  const pipe = redis.pipeline();
  for (const id of ids) pipe.get(pendingKey(epoch, id));
  const values = ids.length ? await pipe.exec() : [];
  const pairs: Pair[] = ids.map((id, i) => {
    if (!state.current_order_keys!.includes(id)) throw new Error('M1_MANIFEST');
    const current = snapshots.get(id) ?? null;
    const pending: OrderSnapshot | null = values[i] ? typeof values[i] === 'string' ? JSON.parse(values[i] as string) : values[i] as OrderSnapshot : null;
    const matches = (s: OrderSnapshot | null) => s?.workflow_epoch === epoch &&
      s.pdf_verification_cycle_id === state.refetch_cycle_id && workflowFingerprint(s) === manifest[id];
    const done = matches(current);
    if (pending && !matches(pending)) throw new Error('M1_PENDING_MISMATCH');
    if (!done && (!pending || !index.keys.includes(id) || (!current && state.phase !== 'awaiting_initialization')))
      throw new Error('M1_PENDING_MISSING');
    return { id, current, pending, done };
  });
  return { raw, index, pairs };
}

export async function getDiffRecoveryReview(): Promise<DiffRecoveryReview | null> {
  let state: RefetchState | null = null;
  const base: DiffRecoveryReview = { refetch_cycle_id: '', phase: 'requires_refetch', review_status: 'conflict',
    can_confirm: false, can_initialize: false, has_new_uninitialized: false, processed_details_fully_recoverable: false,
    diff_confirmed_flag: false, remaining_diff_count: 0, remaining_diff_summary: [], first_absence_count: 0,
    cycle_not_in_open_orders_count: 0, new_uninitialized_count: 0, resolved_uninitialized_cycle_id: null,
    resolved_uninitialized_count: null, resolved_uninitialized_reason: null, resolved_uninitialized_checked_at: null,
    has_fetch_failures: false, failed_unique_keys: [], details_recovery: 'none',
    message: '再取得が必要です。以前の結果ではセッションを開始できません。' };
  try {
    const context = await readWorkflowContext(); state = context.state;
    if (!state || state.phase === 'requires_refetch') return base;
    base.refetch_cycle_id = state.refetch_cycle_id ?? ''; base.phase = state.phase;
    assertPublishedContext(context);
    const { pairs } = await readPairs(state);
    const unfinished = pairs.filter(p => !p.done);
    if (!['awaiting_initialization', 'awaiting_review', 'promoting', 'postprocessing', 'confirmed'].includes(state.phase ?? '') ||
        (state.phase === 'confirmed' && (!state.diff_confirmed_flag || unfinished.length)) ||
        (state.phase !== 'confirmed' && state.diff_confirmed_flag) ||
        (state.phase === 'postprocessing' && unfinished.length)) throw new Error('M1_PHASE');
    const summary: DiffRecoveryItem[] = [];
    for (const p of unfinished) {
      if (!p.current || !p.pending) continue;
      const changes = getStaffReviewSnapshotChanges(p.current, p.pending);
      if (changes.itemChanged || changes.feeChanged || changes.shippingChanged)
        summary.push({ unique_key: p.id, diff_type: changes.itemChanged ? 'item_changed' : changes.feeChanged ? 'fee_changed' : 'other',
          description: changes.itemChanged ? '商品内容が変更されました' : changes.feeChanged ? '送料が変更されました' : '配送方法が変更されました',
          severity: 'warning' });
    }
    const failed = Object.entries(state.order_results ?? {}).filter(([, r]) => r.status === 'fetch_failed').map(([id]) => id);
    for (const id of failed) summary.push({ unique_key: id, diff_type: 'other', description: '詳細取得失敗：今回の処理対象外です', severity: 'warning' });
    const status = state.phase === 'confirmed' ? 'confirmed' : ['promoting', 'postprocessing'].includes(state.phase ?? '') ? 'resuming_partial' : 'fresh';
    const latest = await readWorkflowContext();
    if (latest.stateRaw !== context.stateRaw || latest.attemptRaw !== context.attemptRaw) throw new Error('M1_STATE_CHANGED');
    const review: DiffRecoveryReview = { ...base, review_status: status, can_confirm: !state.has_new_uninitialized && status !== 'confirmed',
      has_new_uninitialized: state.has_new_uninitialized, new_uninitialized_count: state.new_uninitialized_count ?? 0,
      diff_confirmed_flag: state.diff_confirmed_flag, processed_details_fully_recoverable: status === 'fresh',
      remaining_diff_count: summary.length, remaining_diff_summary: summary, has_fetch_failures: !!failed.length,
      failed_unique_keys: failed, details_recovery: status === 'fresh' ? 'full' : 'remaining_only',
      message: status === 'resuming_partial' ? '確認途中の処理を再開します。' : '' };
    review.can_initialize = canInitializeDiffReview(review); return review;
  } catch { return base; }
}

export type ConfirmDiffResult = { status: 'confirmed'; already_complete: boolean } |
  { status: 'not_ready' | 'initialization_required' | 'cycle_mismatch' | 'unsafe_recovery'; message: string };

export async function confirmDiffCycle(requestedCycleId: string, lease: WorkflowLease): Promise<ConfirmDiffResult> {
  try {
    let context = await readWorkflowContext(); assertPublishedContext(context);
    let state = context.state!;
    if (state.refetch_cycle_id !== requestedCycleId) return { status: 'cycle_mismatch', message: '再取得cycleが一致しません。' };
    if (state.has_new_uninitialized) return { status: 'initialization_required', message: '初期化と再取得が必要です。' };
    let data = await readPairs(state);
    if (state.phase === 'confirmed') {
      if (!state.diff_confirmed_flag || data.pairs.some(p => !p.done)) throw new Error('M1_PHASE');
      if (!await redis.workflowMset(contextGuards(context, lease), [{ key: 'orders:refetch_state', value: context.stateRaw! }]))
        throw new Error('M1_STATE_CHANGED');
      return { status: 'confirmed', already_complete: true };
    }
    if (!['awaiting_review', 'promoting', 'postprocessing'].includes(state.phase ?? '') || state.diff_confirmed_flag)
      throw new Error('M1_PHASE');
    if (state.phase === 'postprocessing' && data.pairs.some(p => !p.done)) throw new Error('M1_PHASE');
    if (state.phase !== 'postprocessing') {
      state = { ...state, phase: 'promoting', diff_confirmed_flag: false };
      await setRefetchStateFenced(lease, state);
      // Preserve the existing bounded chunk loop. Progress is proven by snapshots.
      for (let offset = 0; offset < data.pairs.length; offset += DIFF_CONFIRM_CHUNK_SIZE) {
        await renewWorkflowLeaseIfDue(lease);
        context = await readWorkflowContext(); assertPublishedContext(context);
        data = await readPairs(context.state!);
        const chunk = data.pairs.slice(offset, offset + DIFF_CONFIRM_CHUNK_SIZE);
        const index = { ...data.index, keys: data.index.keys.filter(id => !chunk.some(p => p.id === id)) };
        const writes = chunk.filter(p => !p.done).map(p => ({ key: 'order_snapshot:' + p.id, value: JSON.stringify(p.pending!) }));
        writes.push({ key: pendingIndexKey(state.workflow_epoch!), value: JSON.stringify(index) });
        if (!await redis.workflowMset([...contextGuards(context, lease),
          { key: pendingIndexKey(state.workflow_epoch!), expected: data.raw }], writes)) throw new Error('M1_STATE_CHANGED');
        // Deletion follows the proof write: failure leaves an already-promoted pending, never missing proof.
        const deletions = chunk.filter(p => p.pending).map(p => pendingKey(state.workflow_epoch!, p.id));
        if (deletions.length) await fencedMutate(lease, [{ type: 'del', keys: deletions }]);
      }
      state = { ...state, phase: 'postprocessing', diff_confirmed_flag: false };
      await setRefetchStateFenced(lease, state);
    }
    data = await readPairs(state);
    if (data.pairs.some(p => !p.done)) throw new Error('M1_PENDING_MISSING');
    await setRefetchStateFenced(lease, { ...state, phase: 'confirmed', diff_confirmed_flag: true });
    return { status: 'confirmed', already_complete: false };
  } catch { return { status: 'unsafe_recovery', message: '確認状態の整合性を検証できません。再読み込みしてください。' }; }
}

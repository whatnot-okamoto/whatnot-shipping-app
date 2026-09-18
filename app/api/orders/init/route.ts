// M1 init operates only on the latest published current-order set.
import { requireAuth } from '@/lib/auth';
import { fetchOrderedOrders, fetchOrderDetail } from '@/lib/base-api';
import { isBaseOrderSummaryList } from '@/lib/base-order-summary-validation';
import { getIncompleteOrderInitializationKeys, initializeOrderData, generateBundleGroupId,
  getBundleStates, type OrderSnapshot } from '@/lib/order-store';
import type { BaseOrder } from '@/lib/base-api';
import { redis } from '@/lib/upstash';
import { readWorkflowContext, assertPublishedContext, setRefetchStateFenced, pendingKey } from '@/lib/refetch-store';
import { getDiffRecoveryReview, canInitializeDiffReview } from '@/lib/order-diff-confirmation';
import { acquireWorkflowLease, releaseWorkflowLease, renewWorkflowLeaseIfDue,
  ORDERS_OPERATION_IN_PROGRESS_ERROR_CODE } from '@/lib/workflow-operation-lease';

export const maxDuration = 300;
const INIT_BASE_LIST_TIMEOUT_MS = 30_000;
const INIT_BASE_DETAIL_TIMEOUT_MS = 45_000;
const INIT_BASE_PHASE_TIMEOUT_MS = 180_000;

async function timed<T>(parent: AbortSignal, ms: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(ms)]);
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try { return await Promise.race([read(signal), new Promise<never>((_, reject) => {
    abort = () => reject(new Error('M1_INIT_TIMEOUT')); signal.addEventListener('abort', abort, { once: true });
  })]); } finally { signal.removeEventListener('abort', abort); }
}
const unsafe = () => Response.json({ success: false, error_code: 'unsafe_initialization_state',
  message: '初期化できる状態ではありません。再読み込みして確認してください。' }, { status: 409 });

export async function POST(req: Request) {
  const authError = await requireAuth(req); if (authError) return authError;
  let cycle: string;
  try {
    const body = await req.json(); cycle = body.refetch_cycle_id;
    const review = await getDiffRecoveryReview();
    if (typeof cycle !== 'string' || !review || !canInitializeDiffReview(review, cycle)) return unsafe();
  } catch { return unsafe(); }
  const lease = await acquireWorkflowLease('init', cycle);
  if (!lease) return Response.json({ success: false, error_code: ORDERS_OPERATION_IN_PROGRESS_ERROR_CODE }, { status: 409 });
  try {
    const context = await readWorkflowContext(); assertPublishedContext(context);
    const state = context.state!;
    const review = await getDiffRecoveryReview();
    if (!review || !canInitializeDiffReview(review, cycle) || await redis.get('session:current')) return unsafe();
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(INIT_BASE_PHASE_TIMEOUT_MS)]);
    const raw: unknown = await timed(signal, INIT_BASE_LIST_TIMEOUT_MS, s => fetchOrderedOrders({ signal: s }));
    if (!isBaseOrderSummaryList(raw)) throw new Error('M1_BASE_SCHEMA');
    const current = new Set(raw.filter(o => o.dispatch_status === 'ordered' && o.dispatched === null && o.terminated === false).map(o => o.unique_key));
    const ids = (state.initialization_keys ?? []).filter(id => current.has(id) && !state.held_bundle_order_keys?.includes(id));
    const incomplete = await getIncompleteOrderInitializationKeys(ids);
    const details: BaseOrder[] = [];
    const failed: string[] = [];
    const held = new Set(state.held_bundle_order_keys ?? []);
    for (const id of ids.filter(id => incomplete.has(id))) {
      await renewWorkflowLeaseIfDue(lease);
      try {
        signal.throwIfAborted();
        const detail = await timed(signal, INIT_BASE_DETAIL_TIMEOUT_MS, s => fetchOrderDetail(id, { signal: s }));
        if (detail.unique_key !== id) throw new Error('M1_DETAIL_ID');
        const pendingRaw = await redis.getRawString(pendingKey(state.workflow_epoch!, id), 64 * 1024);
        const pending: OrderSnapshot | null = pendingRaw ? JSON.parse(pendingRaw) : null;
        const bundleId = generateBundleGroupId(detail);
        const bundles = await getBundleStates([bundleId]);
        const bundle = bundles.get(bundleId);
        if (!pending || pending.bundle_group_id !== bundleId ||
            bundle?.order_unique_keys.some(member => !state.current_order_keys?.includes(member) || !current.has(member))) {
          held.add(id); continue;
        }
        details.push(detail);
      } catch { failed.push(id); }
    }
    // Retain completed details on a phase timeout; the owner fence still governs every write.
    await renewWorkflowLeaseIfDue(lease);
    const result = await initializeOrderData(details, lease);
    if (result.indexOrdersFailed) failed.push(...details.map(o => o.unique_key));
    const remaining = await getIncompleteOrderInitializationKeys(ids.filter(id => !held.has(id)));
    const failedKeys = [...new Set([...failed, ...remaining])];
    // No mutation of the published membership/results or fingerprint. The next refetch revalidates everything.
    await setRefetchStateFenced(lease, { ...state, post_init_refetch_ready: failedKeys.length === 0,
      initialization_keys: [...remaining], new_uninitialized_count: remaining.size,
      has_new_uninitialized: true, phase: 'awaiting_initialization', diff_confirmed_flag: false });
    return Response.json({ success: failedKeys.length === 0, status: failedKeys.length ? 'partial_failed' : current.size ? 'completed' : 'empty_current_orders',
      initialized: result.u1Count, skipped: 0, failed_unique_keys: failedKeys, warnings: [],
      ...result, message: failedKeys.length ? '初期化が未完了です。再読み込みしてください。' : undefined });
  } catch {
    return Response.json({ success: false, message: '初期化が完了していません。再読み込みして状態を確認してください。' }, { status: 409 });
  } finally { await releaseWorkflowLease(lease).catch(() => false); }
}

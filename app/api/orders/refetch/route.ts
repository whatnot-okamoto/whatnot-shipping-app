// M1: published data is preserved; a persistent attempt fences its eligibility.
import { randomUUID } from 'crypto';
import { requireAuth } from '@/lib/auth';
import { fetchOrderedOrders, fetchOrderDetail } from '@/lib/base-api';
import { isBaseOrderSummaryList } from '@/lib/base-order-summary-validation';
import { getOrderSnapshots, getBundleStates, getIncompleteOrderInitializationKeys,
  buildOrderSnapshotFromDetail, generateBundleGroupId, type OrderSnapshot } from '@/lib/order-store';
import { buildPromotedOrderSnapshot } from '@/lib/order-snapshot-diff';
import { assessOrderForPdf } from '@/lib/pdf-order-assessment';
import { readWorkflowContext, contextRevision, parseRefetchRequest, beginRefetchAttempt,
  failRefetchAttempt, publishRefetch, workflowFingerprint, assertPublishedContext,
  type RefetchState, type RefetchOrderResult } from '@/lib/refetch-store';
import { acquireWorkflowLease, releaseWorkflowLease, renewWorkflowLeaseIfDue,
  ORDERS_OPERATION_IN_PROGRESS_ERROR_CODE } from '@/lib/workflow-operation-lease';
import { getDiffRecoveryReview } from '@/lib/order-diff-confirmation';

export const maxDuration = 300;

export type DiffItem = { unique_key: string; diff_type: 'item_changed' | 'cancelled' | 'fee_changed' | 'new_order' | 'disappeared' | 'other';
  description: string; severity: 'info' | 'warning' | 'blocking' };

async function baseRead<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  bounded.throwIfAborted();
  let rejectAbort: () => void = () => {};
  try {
    return await Promise.race([operation(bounded), new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error('M1_BASE_TIMEOUT'));
      bounded.addEventListener('abort', rejectAbort, { once: true });
    })]);
  } finally { bounded.removeEventListener('abort', rejectAbort); }
}

async function publishedResponse() {
  const review = await getDiffRecoveryReview();
  if (!review || review.review_status === 'conflict') throw new Error('M1_PUBLICATION_UNVERIFIED');
  return Response.json({ success: true, refetch_done_flag: true, diff_confirmed_flag: review.diff_confirmed_flag,
    diff_result: { refetch_cycle_id: review.refetch_cycle_id, has_diff: review.remaining_diff_count > 0,
      has_new_uninitialized: review.has_new_uninitialized, new_uninitialized_count: review.new_uninitialized_count,
      first_absence_count: 0, cycle_not_in_open_orders_count: 0, has_fetch_failures: review.has_fetch_failures,
      failed_unique_keys: review.failed_unique_keys, diff_summary: review.remaining_diff_summary,
      recovery_status: review.review_status, can_confirm: review.can_confirm, can_initialize: review.can_initialize,
      recovery_message: review.message } });
}

// BASE is never accessed by this status/compare-token endpoint.
export async function GET(req: Request) {
  const authError = await requireAuth(req); if (authError) return authError;
  try {
    const context = await readWorkflowContext();
    const requested = new URL(req.url).searchParams.get('request_id');
    if (requested && context.attempt?.request_id !== requested)
      return Response.json({ success: false, error_code: 'M1_REQUEST_SUPERSEDED' }, { status: 409 });
    if (requested && context.attempt?.status === 'published') {
      assertPublishedContext(context); return await publishedResponse();
    }
    return Response.json({ success: true, workflow_epoch: context.adoption.workflow_epoch,
      source_cycle_id: context.state?.refetch_cycle_id ?? null,
      source_publication_revision: contextRevision(context), previous_attempt_id: context.attempt?.request_id ?? null,
      attempt_status: context.attempt?.status ?? null, failure_code: context.attempt?.failure_code ?? null,
      diff_confirmed_flag: context.state?.diff_confirmed_flag ?? false, post_init_refetch_ready: context.state?.post_init_refetch_ready ?? false });
  } catch { return Response.json({ success: false, error_code: 'M1_STATE_UNAVAILABLE' }, { status: 409 }); }
}

export async function POST(req: Request) {
  const authError = await requireAuth(req); if (authError) return authError;
  let input;
  try { input = parseRefetchRequest(await req.json()); }
  catch { return Response.json({ success: false, error_code: 'M1_REQUEST_SCHEMA' }, { status: 400 }); }
  const lease = await acquireWorkflowLease('refetch', input.source_cycle_id);
  if (!lease) return Response.json({ success: false, error_code: ORDERS_OPERATION_IN_PROGRESS_ERROR_CODE }, { status: 409 });
  let started = false;
  try {
    const beginning = await beginRefetchAttempt(input, lease);
    if (beginning.replay) {
      if (beginning.context.attempt?.status === 'published') {
        assertPublishedContext(beginning.context); return await publishedResponse();
      }
      return Response.json({ success: false, error_code: 'M1_ATTEMPT_' + beginning.context.attempt?.status.toUpperCase(),
        error: '前回の再取得は完了していません。状態を確認して明示的に再試行してください。' }, { status: 409 });
    }
    started = true;
    const { context } = beginning;
    const phaseSignal = AbortSignal.any([req.signal, AbortSignal.timeout(180_000)]);
    const raw: unknown = await baseRead(signal => fetchOrderedOrders({ signal }), phaseSignal);
    if (!isBaseOrderSummaryList(raw)) throw new Error('M1_BASE_SCHEMA');
    const current = raw.filter(o => o.dispatch_status === 'ordered' && o.dispatched === null && o.terminated === false);
    const ids = current.map(o => o.unique_key);
    if (ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('M1_CURRENT_SET');
    const cycle = randomUUID();
    const snapshots = await getOrderSnapshots(ids);
    const incomplete = await getIncompleteOrderInitializationKeys(ids);
    const results: Record<string, RefetchOrderResult> = {};
    const pending = new Map<string, OrderSnapshot>();
    for (const id of ids) {
      phaseSignal.throwIfAborted();
      await renewWorkflowLeaseIfDue(lease);
      try {
        const detail = await baseRead(signal => fetchOrderDetail(id, { signal }), phaseSignal);
        if (detail.unique_key !== id) throw new Error('M1_DETAIL_ID');
        const assessment = assessOrderForPdf(detail);
        const candidate = { ...buildOrderSnapshotFromDetail(detail, generateBundleGroupId(detail), cycle),
          workflow_epoch: input.workflow_epoch };
        const existing = snapshots.get(id);
        const promoted = existing ? buildPromotedOrderSnapshot(existing, candidate) : candidate;
        if (!promoted) throw new Error('M1_CANDIDATE');
        pending.set(id, promoted);
        results[id] = { status: assessment.generationOutcome === 'eligible' ? 'verified_eligible' : 'verified_blocked',
          cancellation_state: assessment.cancellationState, issues: assessment.issues };
      } catch {
        phaseSignal.throwIfAborted();
        results[id] = { status: 'fetch_failed', issues: [] };
      }
    }
    const bundles = await getBundleStates([...new Set([...snapshots.values(), ...pending.values()].map(s => s.bundle_group_id))]);
    const held = new Set<string>();
    for (const [id, candidate] of pending) {
      const old = snapshots.get(id);
      if (old && old.bundle_group_id !== candidate.bundle_group_id) held.add(id);
      const bundle = bundles.get(candidate.bundle_group_id);
      const members = [...new Set([...(bundle?.order_unique_keys ?? []),
        ...[...pending].filter(([, p]) => p.bundle_group_id === candidate.bundle_group_id).map(([key]) => key)])];
      if ((old && bundle && !bundle.order_unique_keys.includes(id)) || members.some(member =>
        !ids.includes(member) || results[member]?.status !== 'verified_eligible')) {
        for (const member of members) if (ids.includes(member)) held.add(member);
        held.add(id);
      }
    }
    const initialization = ids.filter(id => incomplete.has(id) && results[id]?.status === 'verified_eligible' && !held.has(id));
    for (const id of pending.keys()) if (!snapshots.has(id) && !initialization.includes(id)) pending.delete(id);
    const manifest = Object.fromEntries([...pending].map(([id, s]) => [id, workflowFingerprint(s)]));
    const state: RefetchState = { schema_version: 1, workflow_epoch: input.workflow_epoch,
      publication_revision: input.source_publication_revision + 1, publication_request_id: input.request_id,
      current_order_keys: ids, confirmation_manifest: manifest, initialization_keys: initialization,
      held_bundle_order_keys: [...held], refetch_cycle_id: cycle, refetch_done_flag: true, diff_confirmed_flag: false,
      refetched_at: new Date().toISOString(), order_results: results, has_new_uninitialized: initialization.length > 0,
      new_uninitialized_count: initialization.length, phase: initialization.length ? 'awaiting_initialization' : 'awaiting_review',
      refetch_result: Object.values(results).some(r => r.status === 'fetch_failed') ? 'partial' : 'complete', first_absence_count: 0 };
    phaseSignal.throwIfAborted();
    await renewWorkflowLeaseIfDue(lease);
    await publishRefetch(context, lease, state, pending);
    return await publishedResponse();
  } catch (error) {
    if (started) await failRefetchAttempt(input.request_id, lease, 'refetch_failed').catch(() => undefined);
    const code = error instanceof Error && /^M1_[A-Z_]+$/.test(error.message) ? error.message : 'M1_REFETCH_FAILED';
    return Response.json({ success: false, error_code: code,
      error: '再取得を完了できませんでした。以前の一覧は参考表示です。状態を確認して再試行してください。' }, { status: 409 });
  } finally { await releaseWorkflowLease(lease).catch(() => false); }
}

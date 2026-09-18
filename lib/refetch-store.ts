// orders:refetch_state（固定キー）の読み書き管理
// 再取得・差分確認フラグの永続化（Step 4-A3）

import { redis } from "@/lib/upstash";
import { createHash } from 'crypto';
import { workflowFingerprint } from './order-snapshot-diff';
export { workflowFingerprint } from './order-snapshot-diff';
import { WORKFLOW_LEASE_KEY } from './workflow-operation-lease';
import type { OrderSnapshot } from './order-store';
import { fencedMutate, type WorkflowLease } from "@/lib/workflow-operation-lease";
import type {
  CancellationState,
  GenerationIssueCode,
} from "@/lib/pdf-order-assessment";

export const REFETCH_STATE_KEY = "orders:refetch_state";

export type RefetchPhase =
  | "requires_refetch"
  | "awaiting_initialization"
  | "awaiting_review"
  | "promoting"
  | "postprocessing"
  | "confirmed";

export type RefetchState = {
  schema_version?: 1;
  workflow_epoch?: string;
  publication_revision?: number;
  publication_request_id?: string;
  publication_fingerprint?: string;
  current_order_keys?: string[];
  confirmation_manifest?: Record<string, string>;
  initialization_keys?: string[];
  held_bundle_order_keys?: string[];
  refetch_done_flag: boolean;
  diff_confirmed_flag: boolean;
  refetched_at: string | null;   // ISO 8601。resetRefetchState()時はnull
  has_new_uninitialized: boolean;
  refetch_cycle_id?: string;
  refetch_result?: "complete" | "partial";
  order_results?: Record<string, RefetchOrderResult>;
  phase?: RefetchPhase;
  new_uninitialized_count?: number;
  first_absence_count?: number;
  post_init_refetch_ready?: boolean;
  /** initでBASE現在注文0件を観測し、authorized refetchの再確認を待つ。 */
  empty_init_source_cycle_id?: string;
  empty_init_uninitialized_count?: number;
  empty_init_checked_at?: string;
  /** initとauthorized refetchの双方で0件を確認した集約監査情報。 */
  resolved_uninitialized_cycle_id?: string;
  resolved_uninitialized_count?: number;
  resolved_uninitialized_reason?: "not_in_current_open_orders";
  resolved_uninitialized_checked_at?: string;
};

export type RefetchOrderResult = {
  status:
    | "verified_eligible"
    | "verified_blocked"
    | "fetch_failed"
    | "unprocessed"
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
  if (state.workflow_epoch) {
    const context = await readWorkflowContext();
    assertPublishedContext(context);
    if (context.state?.refetch_cycle_id !== state.refetch_cycle_id) throw new Error('M1_CYCLE_CHANGED');
    checkBytes(JSON.stringify(state), 128 * 1024);
    if (!await redis.workflowMset(contextGuards(context, lease), [
      { key: REFETCH_STATE_KEY, value: JSON.stringify(state) },
    ])) throw new Error('M1_STATE_CHANGED');
    return;
  }
  await fencedMutate(lease, [
    { type: "set", key: REFETCH_STATE_KEY, value: JSON.stringify(state) },
  ]);
}

export const WORKFLOW_EPOCH_KEY = 'orders:workflow_epoch';
export const REFETCH_ATTEMPT_KEY = 'orders:refetch_attempt';
export type WorkflowAdoption = {
  schema_version: 1; workflow_epoch: string; adoption_status: 'adopted';
  migration_version: 'diff-modal-01:v1'; migration_id: string;
  source_fingerprint: string; adopted_at: string;
};
export type RefetchAttempt = {
  schema_version: 1; workflow_epoch: string; request_id: string; input_fingerprint: string;
  source_cycle_id: string | null; source_publication_revision: number;
  started_at: string; status: 'running' | 'failed' | 'published';
  failure_code: string | null; finished_at: string | null;
  published_cycle_id: string | null; published_revision: number | null;
  published_fingerprint: string | null;
};
export type RefetchRequest = {
  request_id: string; workflow_epoch: string; source_cycle_id: string | null;
  source_publication_revision: number; previous_attempt_id: string | null;
};
export type WorkflowContext = {
  epochRaw: string | null; stateRaw: string | null; attemptRaw: string | null;
  adoption: WorkflowAdoption; state: RefetchState | null; attempt: RefetchAttempt | null;
};

export function checkBytes(raw: string, limit: number): void {
  if (Buffer.byteLength(raw, 'utf8') > limit) throw new Error('M1_VALUE_LIMIT');
}
export function rawFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function pendingIndexKey(epoch: string): string {
  return `index:order_snapshot_pending:epoch:${epoch}`;
}
export function pendingKey(epoch: string, key: string): string {
  return `order_snapshot_pending:epoch:${epoch}:${key}`;
}
export function publicationFingerprint(state: RefetchState): string {
  return workflowFingerprint({ epoch: state.workflow_epoch, cycle: state.refetch_cycle_id,
    revision: state.publication_revision, request: state.publication_request_id,
    keys: state.current_order_keys, results: state.order_results, manifest: state.confirmation_manifest,
    held: state.held_bundle_order_keys });
}
export function isWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export async function readWorkflowContext(): Promise<WorkflowContext> {
  const [epochRaw, stateRaw, attemptRaw] = await Promise.all([
    redis.getRawString(WORKFLOW_EPOCH_KEY, 4096), redis.getRawString(REFETCH_STATE_KEY, 128 * 1024),
    redis.getRawString(REFETCH_ATTEMPT_KEY, 4096),
  ]);
  const adoption = epochRaw ? JSON.parse(epochRaw) as WorkflowAdoption : null;
  if (!adoption || adoption.schema_version !== 1 || adoption.adoption_status !== 'adopted' ||
      adoption.migration_version !== 'diff-modal-01:v1' || !isWorkflowId(adoption.workflow_epoch))
    throw new Error('M1_ADOPTION_REQUIRED');
  const state: RefetchState | null = stateRaw ? JSON.parse(stateRaw) : null;
  const attempt: RefetchAttempt | null = attemptRaw ? JSON.parse(attemptRaw) : null;
  if (state && (state.schema_version !== 1 || state.workflow_epoch !== adoption.workflow_epoch ||
      !Number.isSafeInteger(state.publication_revision) || Number(state.publication_revision) < 0))
    throw new Error('M1_STATE_SCHEMA');
  if (attempt && (attempt.schema_version !== 1 || attempt.workflow_epoch !== adoption.workflow_epoch ||
      !isWorkflowId(attempt.request_id) || !['running', 'failed', 'published'].includes(attempt.status) ||
      !Number.isSafeInteger(attempt.source_publication_revision))) throw new Error('M1_ATTEMPT_SCHEMA');
  // A consistent double read also rejects read-only classification across a publication.
  const [latest, latestAttempt, latestEpoch] = await Promise.all([
    redis.getRawString(REFETCH_STATE_KEY, 128 * 1024), redis.getRawString(REFETCH_ATTEMPT_KEY, 4096),
    redis.getRawString(WORKFLOW_EPOCH_KEY, 4096),
  ]);
  if (latest !== stateRaw || latestAttempt !== attemptRaw || latestEpoch !== epochRaw) throw new Error('M1_STATE_CHANGED');
  return { epochRaw, stateRaw, attemptRaw, adoption, state, attempt };
}
export function contextRevision(context: WorkflowContext): number {
  return context.state?.publication_revision ?? context.attempt?.published_revision ?? 0;
}
export function contextGuards(context: WorkflowContext, lease: WorkflowLease) {
  return [
    { key: WORKFLOW_LEASE_KEY, expected: lease.serialized },
    { key: WORKFLOW_EPOCH_KEY, expected: context.epochRaw },
    { key: REFETCH_STATE_KEY, expected: context.stateRaw },
    { key: REFETCH_ATTEMPT_KEY, expected: context.attemptRaw },
    { key: 'session:current', expected: null },
  ];
}
export function assertPublishedContext(context: WorkflowContext): void {
  const { state: s, attempt: a } = context;
  if (!s || !a || a.status !== 'published' || s.refetch_done_flag !== true ||
      a.published_revision !== s.publication_revision || a.published_cycle_id !== s.refetch_cycle_id ||
      a.request_id !== s.publication_request_id || a.published_fingerprint !== s.publication_fingerprint ||
      s.publication_fingerprint !== publicationFingerprint(s)) throw new Error('M1_REFETCH_REQUIRED');
}
export function parseRefetchRequest(raw: unknown): RefetchRequest {
  if (!raw || typeof raw !== 'object') throw new Error('M1_REQUEST_SCHEMA');
  const r = raw as RefetchRequest;
  if (Object.keys(raw).some(key => !['request_id', 'workflow_epoch', 'source_cycle_id',
    'source_publication_revision', 'previous_attempt_id'].includes(key))) throw new Error('M1_REQUEST_SCHEMA');
  if (!isWorkflowId(r.request_id) || !isWorkflowId(r.workflow_epoch) ||
      !(r.source_cycle_id === null || isWorkflowId(r.source_cycle_id)) ||
      !(r.previous_attempt_id === null || isWorkflowId(r.previous_attempt_id)) ||
      !Number.isSafeInteger(r.source_publication_revision) || r.source_publication_revision < 0)
    throw new Error('M1_REQUEST_SCHEMA');
  return { request_id: r.request_id, workflow_epoch: r.workflow_epoch, source_cycle_id: r.source_cycle_id,
    source_publication_revision: r.source_publication_revision, previous_attempt_id: r.previous_attempt_id };
}
export async function beginRefetchAttempt(input: RefetchRequest, lease: WorkflowLease) {
  let context = await readWorkflowContext();
  const fingerprint = workflowFingerprint(input);
  const old = context.attempt;
  if (old?.request_id === input.request_id) {
    if (old.input_fingerprint !== fingerprint) throw new Error('M1_REQUEST_REUSED');
    return { context, replay: true };
  }
  if (input.workflow_epoch !== context.adoption.workflow_epoch ||
      input.source_cycle_id !== (context.state?.refetch_cycle_id ?? null) ||
      input.source_publication_revision !== contextRevision(context) ||
      input.previous_attempt_id !== (old?.request_id ?? null)) throw new Error('M1_REQUEST_SUPERSEDED');
  if (context.state?.refetch_done_flag && !context.state.diff_confirmed_flag &&
      !context.state.post_init_refetch_ready && old?.status === 'published') throw new Error('M1_REVIEW_REQUIRED');
  if (old?.status === 'running') {
    const failed: RefetchAttempt = { ...old, status: 'failed', failure_code: 'interrupted', finished_at: new Date().toISOString() };
    if (!await redis.workflowMset(contextGuards(context, lease), [{ key: REFETCH_ATTEMPT_KEY, value: JSON.stringify(failed) }]))
      throw new Error('M1_STATE_CHANGED');
    context = await readWorkflowContext();
  }
  const attempt: RefetchAttempt = { schema_version: 1, workflow_epoch: input.workflow_epoch,
    request_id: input.request_id, input_fingerprint: fingerprint, source_cycle_id: input.source_cycle_id,
    source_publication_revision: input.source_publication_revision, started_at: new Date().toISOString(),
    status: 'running', failure_code: null, finished_at: null, published_cycle_id: null,
    published_revision: null, published_fingerprint: null };
  const raw = JSON.stringify(attempt); checkBytes(raw, 4096);
  if (!await redis.workflowMset(contextGuards(context, lease), [{ key: REFETCH_ATTEMPT_KEY, value: raw }]))
    throw new Error('M1_STATE_CHANGED');
  return { context: { ...context, attempt, attemptRaw: raw }, replay: false };
}
export async function failRefetchAttempt(requestId: string, lease: WorkflowLease, failureCode: string): Promise<void> {
  const context = await readWorkflowContext();
  if (context.attempt?.request_id !== requestId || context.attempt.status !== 'running') return;
  const next = { ...context.attempt, status: 'failed', failure_code: failureCode, finished_at: new Date().toISOString() };
  checkBytes(JSON.stringify(next), 4096);
  if (!await redis.workflowMset(contextGuards(context, lease), [{ key: REFETCH_ATTEMPT_KEY, value: JSON.stringify(next) }]))
    throw new Error('M1_STATE_CHANGED');
}
export async function publishRefetch(
  context: WorkflowContext, lease: WorkflowLease, state: RefetchState, candidates: Map<string, OrderSnapshot>
): Promise<void> {
  const a = context.attempt;
  if (!a || a.status !== 'running' || state.workflow_epoch !== a.workflow_epoch ||
      state.publication_revision !== a.source_publication_revision + 1 || state.publication_request_id !== a.request_id)
    throw new Error('M1_PUBLICATION_MISMATCH');
  const ids = state.current_order_keys ?? [];
  if (ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !isWorkflowId(id)) ||
      !state.order_results || Object.keys(state.order_results).length !== ids.length ||
      ids.some(id => !Object.hasOwn(state.order_results!, id))) throw new Error('M1_CURRENT_SET');
  if (candidates.size > 100 || Object.keys(state.confirmation_manifest ?? {}).length !== candidates.size)
    throw new Error('M1_MANIFEST');
  const writes: Array<{ key: string; value: string }> = [];
  let total = 0;
  for (const [id, value] of candidates) {
    if (!ids.includes(id) || value.unique_key !== id || value.workflow_epoch !== state.workflow_epoch ||
        value.pdf_verification_cycle_id !== state.refetch_cycle_id ||
        state.confirmation_manifest?.[id] !== workflowFingerprint(value)) throw new Error('M1_PENDING_MISMATCH');
    const raw = JSON.stringify(value); checkBytes(raw, 64 * 1024); total += Buffer.byteLength(raw);
    writes.push({ key: pendingKey(a.workflow_epoch, id), value: raw });
  }
  if (total > 512 * 1024) throw new Error('M1_PENDING_LIMIT');
  state.publication_fingerprint = publicationFingerprint(state);
  const stateRaw = JSON.stringify(state); checkBytes(stateRaw, 128 * 1024);
  const indexRaw = JSON.stringify({ schema_version: 1, workflow_epoch: a.workflow_epoch,
    refetch_cycle_id: state.refetch_cycle_id, keys: [...candidates.keys()] });
  checkBytes(indexRaw, 32 * 1024);
  const published: RefetchAttempt = { ...a, status: 'published', finished_at: new Date().toISOString(),
    published_revision: state.publication_revision!, published_cycle_id: state.refetch_cycle_id!,
    published_fingerprint: state.publication_fingerprint };
  const attemptRaw = JSON.stringify(published); checkBytes(attemptRaw, 4096);
  writes.push({ key: pendingIndexKey(a.workflow_epoch), value: indexRaw },
    { key: REFETCH_STATE_KEY, value: stateRaw }, { key: REFETCH_ATTEMPT_KEY, value: attemptRaw });
  if (!await redis.workflowMset(contextGuards(context, lease), writes)) throw new Error('M1_STATE_CHANGED');
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

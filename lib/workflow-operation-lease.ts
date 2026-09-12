import { randomUUID } from "crypto";
import { redis } from "@/lib/upstash";
import type { RedisMutation } from "@/lib/redis-like";

export const WORKFLOW_LEASE_KEY = "orders:workflow_operation_lease";
export const WORKFLOW_LEASE_TTL_SECONDS = 90;
export const WORKFLOW_LEASE_RENEW_INTERVAL_MS = 30_000;
export const DIFF_CONFIRM_CHUNK_SIZE = 100;
export const ORDERS_OPERATION_IN_PROGRESS_ERROR_CODE =
  "orders_operation_in_progress";

export type WorkflowOperation =
  | "init"
  | "refetch"
  | "diff-confirm"
  | "session-start";

export type WorkflowLease = {
  operation: WorkflowOperation;
  cycle_id: string | null;
  owner_token: string;
  serialized: string;
  renewed_at_ms: number;
};

export class WorkflowLeaseLostError extends Error {
  constructor() {
    super("The workflow operation lease is no longer owned by this request.");
    this.name = "WorkflowLeaseLostError";
  }
}

export async function acquireWorkflowLease(
  operation: WorkflowOperation,
  cycleId: string | null
): Promise<WorkflowLease | null> {
  const value = {
    operation,
    cycle_id: cycleId,
    owner_token: randomUUID(),
  };
  const serialized = JSON.stringify(value);
  const acquired = await redis.set(WORKFLOW_LEASE_KEY, serialized, {
    nx: true,
    ex: WORKFLOW_LEASE_TTL_SECONDS,
  });
  if (acquired !== "OK") return null;
  return { ...value, serialized, renewed_at_ms: Date.now() };
}

export async function renewWorkflowLeaseIfDue(
  lease: WorkflowLease,
  nowMs: number = Date.now()
): Promise<void> {
  if (nowMs - lease.renewed_at_ms < WORKFLOW_LEASE_RENEW_INTERVAL_MS) return;
  const renewed = await redis.compareAndExpire(
    WORKFLOW_LEASE_KEY,
    lease.serialized,
    WORKFLOW_LEASE_TTL_SECONDS
  );
  if (!renewed) throw new WorkflowLeaseLostError();
  lease.renewed_at_ms = nowMs;
}

export async function fencedMutate(
  lease: WorkflowLease,
  mutations: RedisMutation[]
): Promise<unknown[]> {
  const result = await redis.fencedMutate(
    WORKFLOW_LEASE_KEY,
    lease.serialized,
    mutations
  );
  if (!result.applied) throw new WorkflowLeaseLostError();
  return result.results;
}

export async function releaseWorkflowLease(
  lease: WorkflowLease
): Promise<boolean> {
  return redis.compareAndDelete(WORKFLOW_LEASE_KEY, lease.serialized);
}

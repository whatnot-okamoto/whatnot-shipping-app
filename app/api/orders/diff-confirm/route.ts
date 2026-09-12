// POST /api/orders/diff-confirm
// pending snapshotを確認・昇格し、diff_confirmed_flagをONにする。
// has_new_uninitialized=trueの場合は拒否する（Section 0 絶対禁止事項）。

import { requireAuth } from "@/lib/auth";
import {
  confirmDiffCycle,
  getDiffRecoveryReview,
} from "@/lib/order-diff-confirmation";
import {
  acquireWorkflowLease,
  releaseWorkflowLease,
  WorkflowLeaseLostError,
} from "@/lib/workflow-operation-lease";

export async function GET(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;
  const review = await getDiffRecoveryReview();
  if (!review) {
    return Response.json({ success: false, error: "再取得状態がありません。" }, { status: 404 });
  }
  return Response.json({ success: true, review });
}

export async function POST(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ success: false, error: "再読み込みしてから確認してください。" }, { status: 400 });
  }
  const refetchCycleId =
    body && typeof body === "object" && "refetch_cycle_id" in body
      ? (body as { refetch_cycle_id?: unknown }).refetch_cycle_id
      : null;
  if (typeof refetchCycleId !== "string" || !refetchCycleId) {
    return Response.json({ success: false, error: "再読み込みしてから確認してください。" }, { status: 400 });
  }

  const lease = await acquireWorkflowLease("diff-confirm", refetchCycleId);
  if (!lease) {
    return Response.json({ success: false, error: "別の更新処理が進行中です。" }, { status: 409 });
  }
  try {
    const result = await confirmDiffCycle(refetchCycleId, lease);
    if (result.status === "confirmed") {
      return Response.json({
        success: true,
        diff_confirmed_flag: true,
        already_complete: result.already_complete,
      });
    }
    const status = result.status === "not_ready" ? 400 : 409;
    return Response.json({ success: false, error: result.message }, { status });
  } catch (error) {
    if (error instanceof WorkflowLeaseLostError) {
      return Response.json({ success: false, error: "更新権限が失効しました。再読み込みしてください。" }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  } finally {
    await releaseWorkflowLease(lease).catch(() => false);
  }
}

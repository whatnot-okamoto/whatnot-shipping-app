// POST /api/session/start
// セッションを開始し、bundle_group_id 集合をロックする（DATA-01 T5）
//
// Body: { bundle_group_ids: string[] }

import { startSession } from "@/lib/session-store";
import { getRefetchState } from "@/lib/refetch-store";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("bundle_group_ids" in body) ||
    !Array.isArray((body as { bundle_group_ids: unknown }).bundle_group_ids) ||
    (body as { bundle_group_ids: unknown[] }).bundle_group_ids.length === 0
  ) {
    return Response.json(
      { error: "INVALID_BODY: bundle_group_ids must be a non-empty array" },
      { status: 400 }
    );
  }

  const { bundle_group_ids } = body as { bundle_group_ids: string[] };

  // サーバー側検証：再取得・差分確認が完了していない場合はセッション開始を拒否
  const refetchState = await getRefetchState();
  if (
    !refetchState ||
    refetchState.refetch_done_flag !== true ||
    refetchState.diff_confirmed_flag !== true ||
    refetchState.has_new_uninitialized === true
  ) {
    return Response.json(
      { error: "REFETCH_REQUIRED: 再取得・差分確認を完了してからセッションを開始してください" },
      { status: 409 }
    );
  }

  try {
    const session = await startSession(bundle_group_ids);
    return Response.json({ success: true, session });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("SESSION_CONFLICT") ? 409 : 500;
    return Response.json({ error: message }, { status });
  }
}

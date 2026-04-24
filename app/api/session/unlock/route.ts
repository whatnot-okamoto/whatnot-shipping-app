// POST /api/session/unlock
// セッションを緊急解除する（DATA-01 T7）
//
// Body: { executed_by: string, reason: string }
// reason は必須。空文字不可（CONFIRM-01 準拠・確認ダイアログ・理由入力必須）。
// session:{session_id} は削除しない（emergency_unlock_log を監査証跡として永続保持）。

import { getCurrentSession, emergencyUnlockSession } from "@/lib/session-store";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const { executed_by, reason } =
    (body as { executed_by?: string; reason?: string }) ?? {};

  if (!executed_by || typeof executed_by !== "string" || executed_by.trim() === "") {
    return Response.json(
      { error: "INVALID_BODY: executed_by is required" },
      { status: 400 }
    );
  }
  if (!reason || typeof reason !== "string" || reason.trim() === "") {
    return Response.json(
      { error: "REASON_REQUIRED: reason must not be empty" },
      { status: 400 }
    );
  }

  try {
    const session = await getCurrentSession();
    if (!session) {
      return Response.json(
        { error: "SESSION_NOT_FOUND: No active session" },
        { status: 404 }
      );
    }

    await emergencyUnlockSession(
      session.session_id,
      executed_by.trim(),
      reason.trim()
    );

    return Response.json({
      success: true,
      unlocked_session_id: session.session_id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

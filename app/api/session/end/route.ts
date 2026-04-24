// POST /api/session/end
// セッションを正常終了する（DATA-01 T6）
//
// session:current からアクティブな session_id を取得して終了処理を行う。
// 出荷完了注文の U1・U2・U4 削除は Step 8 で実装するため対象外。

import { getCurrentSession, endSession } from "@/lib/session-store";

export async function POST() {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return Response.json(
        { error: "SESSION_NOT_FOUND: No active session" },
        { status: 404 }
      );
    }

    await endSession(session.session_id);
    return Response.json({ success: true, ended_session_id: session.session_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

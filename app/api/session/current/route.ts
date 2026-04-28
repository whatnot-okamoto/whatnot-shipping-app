// GET /api/session/current
// 現在のセッション状態を返す。
// session:current が未設定の場合は { session: null } を返す（セッションなし）。
//
// 参照順序: session:current → session_id → session:{session_id}
// （DATA-01 §5 session:currentポインタ構造）

import { getCurrentSession } from "@/lib/session-store";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  try {
    const session = await getCurrentSession();
    return Response.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

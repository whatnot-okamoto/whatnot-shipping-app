// PATCH /api/orders/hold
// U1 の hold_flag / hold_reason を更新する。
// activeセッションが存在する場合は checklist_printed_flag を false にする（DATA-01 T8準拠）。

import { NextRequest } from "next/server";
import { redis } from "@/lib/upstash";
import type { U1Data } from "@/lib/order-store";
import type { U3Data } from "@/lib/session-store";

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json() as {
      unique_key?: unknown;
      hold_flag?: unknown;
      hold_reason?: unknown;
    };

    if (!body.unique_key || typeof body.unique_key !== "string") {
      return Response.json({ success: false, error: "unique_key が不正です" }, { status: 400 });
    }
    const unique_key = body.unique_key;

    if (typeof body.hold_flag !== "boolean") {
      return Response.json(
        { success: false, error: "hold_flag は boolean を指定してください" },
        { status: 400 }
      );
    }

    const u1Raw = await redis.get<string | U1Data>(`order:${unique_key}`);
    if (!u1Raw) {
      return Response.json({ success: false, error: "注文が見つかりません" }, { status: 404 });
    }
    const u1: U1Data = typeof u1Raw === "string" ? JSON.parse(u1Raw) : u1Raw;

    const snapRaw = await redis.get<string>(`order_snapshot:${unique_key}`);
    if (!snapRaw) {
      return Response.json({ success: false, error: "スナップショットが見つかりません" }, { status: 404 });
    }

    if (u1.cancelled_flag) {
      return Response.json({ success: false, error: "キャンセル済みの注文は変更できません" }, { status: 400 });
    }

    const hold_reason = typeof body.hold_reason === "string" ? body.hold_reason : "";

    // U1更新
    await redis.set(
      `order:${unique_key}`,
      JSON.stringify({ ...u1, hold_flag: body.hold_flag, hold_reason })
    );

    // U3更新: activeセッションが存在する場合のみ checklist_printed_flag を false にする
    // 失敗してもU1更新は完了済みのためエラーにしない
    try {
      const sessionId = await redis.get<string>("session:current");
      if (sessionId) {
        const sessionRaw = await redis.get<string | U3Data>(`session:${sessionId}`);
        if (sessionRaw) {
          const sessionData: U3Data =
            typeof sessionRaw === "string" ? JSON.parse(sessionRaw) : sessionRaw;
          if (sessionData.session_status === "active") {
            await redis.set(
              `session:${sessionId}`,
              JSON.stringify({ ...sessionData, checklist_printed_flag: false })
            );
          }
        }
      }
    } catch {
      // セッション更新失敗は握り潰す
    }

    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

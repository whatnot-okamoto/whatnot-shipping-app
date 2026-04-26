// PATCH /api/orders/receipt
// U1 の receipt_required / receipt_name / receipt_note をまとめて更新する。

import { NextRequest } from "next/server";
import { redis } from "@/lib/upstash";
import type { U1Data } from "@/lib/order-store";

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json() as {
      unique_key?: unknown;
      receipt_required?: unknown;
      receipt_name?: unknown;
      receipt_note?: unknown;
    };

    if (!body.unique_key || typeof body.unique_key !== "string") {
      return Response.json({ success: false, error: "unique_key が不正です" }, { status: 400 });
    }
    const unique_key = body.unique_key;

    if (typeof body.receipt_required !== "boolean") {
      return Response.json(
        { success: false, error: "receipt_required は boolean を指定してください" },
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

    const receipt_name = typeof body.receipt_name === "string" ? body.receipt_name : u1.receipt_name;
    const receipt_note = typeof body.receipt_note === "string" ? body.receipt_note : u1.receipt_note;

    await redis.set(
      `order:${unique_key}`,
      JSON.stringify({ ...u1, receipt_required: body.receipt_required, receipt_name, receipt_note })
    );
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import {
  prepareReceiptOrder,
  ReceiptOrderFetchError,
} from "@/lib/receipt-share";

const ERROR_GENERIC = "注文情報を取得できませんでした。注文IDを確認してください。";

export async function POST(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  let uniqueKey: string;
  try {
    const body = (await req.json()) as { unique_key?: unknown };
    uniqueKey =
      typeof body.unique_key === "string" ? body.unique_key.trim() : "";
  } catch {
    return NextResponse.json(
      { error: "入力内容を読み取れませんでした。" },
      { status: 400 }
    );
  }

  if (!uniqueKey || uniqueKey.length > 128) {
    return NextResponse.json(
      { error: "BASE注文IDを入力してください。" },
      { status: 400 }
    );
  }

  try {
    const { summary } = await prepareReceiptOrder(uniqueKey);
    return NextResponse.json(
      { order: summary },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof ReceiptOrderFetchError) {
      return NextResponse.json(
        {
          outcome: "retryable_error",
          error: "注文詳細を取得できませんでした。時間をおいて再試行してください。",
        },
        { status: 503 }
      );
    }
    console.error("[receipts/order] order lookup failed");
    return NextResponse.json({ error: ERROR_GENERIC }, { status: 500 });
  }
}

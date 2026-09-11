import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import {
  prepareReceiptOrder,
  ReceiptGenerationError,
  ReceiptOrderFetchError,
} from "@/lib/receipt-share";
import {
  createReceiptShareToken,
  ReceiptShareTokenError,
  validateReceiptShareInput,
} from "@/lib/receipt-share-token";

const ERROR_GENERIC = "共有URLを作成できませんでした。再試行してください。";

export async function POST(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  let uniqueKey: string;
  let receiptName: string;
  let receiptNote: string;
  try {
    const body = (await req.json()) as {
      unique_key?: unknown;
      receipt_name?: unknown;
      receipt_note?: unknown;
    };
    uniqueKey =
      typeof body.unique_key === "string" ? body.unique_key.trim() : "";
    receiptName =
      typeof body.receipt_name === "string" ? body.receipt_name : "";
    receiptNote =
      typeof body.receipt_note === "string" ? body.receipt_note : "";
  } catch {
    return NextResponse.json(
      { error: "入力内容を読み取れませんでした。" },
      { status: 400 }
    );
  }

  try {
    validateReceiptShareInput({ uniqueKey, receiptName, receiptNote });
    const { summary, assessment } = await prepareReceiptOrder(uniqueKey);
    if (assessment.generationOutcome === "blocked") {
      throw new ReceiptGenerationError(assessment.issues);
    }
    const { token, payload } = createReceiptShareToken({
      uniqueKey,
      receiptName,
      receiptNote,
    });
    const shareUrl = new URL(`/receipt/${token}`, req.url).toString();

    return NextResponse.json(
      {
        share_url: shareUrl,
        expires_at: payload.expiresAt,
        order: summary,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (
      error instanceof ReceiptShareTokenError &&
      error.code === "invalid"
    ) {
      return NextResponse.json(
        {
          error:
            "宛名または但し書きに入力できない文字があるか、文字数が上限を超えています。",
        },
        { status: 400 }
      );
    }
    if (error instanceof ReceiptGenerationError) {
      return NextResponse.json(
        {
          outcome: "blocked",
          error: "この注文は現在の内容では領収書を発行できません。",
          issues: error.issues,
        },
        { status: 422 }
      );
    }
    if (error instanceof ReceiptOrderFetchError) {
      return NextResponse.json(
        {
          outcome: "retryable_error",
          error: "注文詳細を取得できませんでした。時間をおいて再試行してください。",
        },
        { status: 503 }
      );
    }
    console.error("[receipts/share] share URL creation failed");
    return NextResponse.json({ error: ERROR_GENERIC }, { status: 500 });
  }
}

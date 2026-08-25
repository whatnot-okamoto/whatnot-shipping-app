import {
  generateSharedReceiptPdf,
  ReceiptGenerationError,
} from "@/lib/receipt-share";
import {
  readReceiptShareToken,
  ReceiptShareTokenError,
} from "@/lib/receipt-share-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_ERROR_MESSAGE =
  "この領収書URLは利用できません。ショップへ再発行をご依頼ください。";

function commonSecurityHeaders(): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return headers;
}

function publicErrorResponse(status: number): Response {
  const headers = commonSecurityHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'"
  );

  return new Response(
    `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>領収書URLを利用できません</title>
  </head>
  <body style="margin:0;background:#f8fafc;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <main style="max-width:560px;margin:80px auto;padding:24px">
      <section style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;box-shadow:0 1px 2px rgba(0,0,0,.05)">
        <h1 style="font-size:20px;margin:0 0 16px">領収書を表示できません</h1>
        <p style="font-size:15px;line-height:1.8;margin:0">${PUBLIC_ERROR_MESSAGE}</p>
      </section>
    </main>
  </body>
</html>`,
    { status, headers }
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const payload = readReceiptShareToken(token);
    const { pdfBytes, uniqueKeySuffix } =
      await generateSharedReceiptPdf(payload);

    const filenameAscii = `BASE_receipt_${uniqueKeySuffix}.pdf`;
    const filenameJa = `BASE領収書_${uniqueKeySuffix}.pdf`;
    const headers = commonSecurityHeaders();
    headers.set("Content-Type", "application/pdf");
    headers.set(
      "Content-Disposition",
      `inline; filename="${filenameAscii}"; filename*=UTF-8''${encodeURIComponent(filenameJa)}`
    );

    return new Response(Buffer.from(pdfBytes), { status: 200, headers });
  } catch (error) {
    if (
      error instanceof ReceiptShareTokenError &&
      (error.code === "invalid" || error.code === "expired")
    ) {
      return publicErrorResponse(410);
    }
    if (error instanceof ReceiptGenerationError) {
      return publicErrorResponse(422);
    }
    console.error("[receipt/public] receipt generation failed");
    return publicErrorResponse(503);
  }
}

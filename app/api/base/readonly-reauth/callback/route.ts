import { NextResponse, type NextRequest } from "next/server";
import { getAdminSessionNonce, requireAuth } from "@/lib/auth";
import {
  BaseReadonlyOAuthExchangeError,
  BaseReadonlyOAuthStateError,
} from "@/lib/base-readonly-oauth";
import { getBaseReadonlyOAuthModule } from "@/lib/base-readonly-oauth-runtime";
import { isDevelopmentRuntime, resolveRuntimeConfig } from "@/lib/runtime-mode";

export const runtime = "nodejs";

function resultUrl(request: NextRequest, query: string): URL {
  return new URL(`/orders/readonly-reauth?${query}`, request.url);
}

export async function GET(request: NextRequest) {
  const runtimeConfig = resolveRuntimeConfig();
  if (!isDevelopmentRuntime(runtimeConfig)) {
    return new Response(null, { status: 404 });
  }

  const authError = await requireAuth(request);
  if (authError) return authError;

  const sessionNonce = await getAdminSessionNonce(request);
  if (!sessionNonce) {
    return NextResponse.redirect(resultUrl(request, "error=session_mismatch"), 302);
  }

  try {
    const result = await getBaseReadonlyOAuthModule().completeCallback({
      requestUrl: request.url,
      sessionNonce,
    });
    return NextResponse.redirect(
      resultUrl(request, result === "authorized" ? "success=true" : "error=denied"),
      302
    );
  } catch (error) {
    const code =
      error instanceof BaseReadonlyOAuthStateError
        ? "state_invalid"
        : error instanceof BaseReadonlyOAuthExchangeError
          ? "token_exchange_failed"
          : "save_failed";
    return NextResponse.redirect(resultUrl(request, `error=${code}`), 302);
  }
}

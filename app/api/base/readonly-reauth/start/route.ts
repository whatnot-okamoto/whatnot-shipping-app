import { NextResponse, type NextRequest } from "next/server";
import { getAdminSessionNonce, requireAuth } from "@/lib/auth";
import { getBaseReadonlyOAuthModule } from "@/lib/base-readonly-oauth-runtime";
import { isDevelopmentRuntime, resolveRuntimeConfig } from "@/lib/runtime-mode";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const runtimeConfig = resolveRuntimeConfig();
  if (!isDevelopmentRuntime(runtimeConfig)) {
    return new Response(null, { status: 404 });
  }

  const authError = await requireAuth(request);
  if (authError) return authError;

  const sessionNonce = await getAdminSessionNonce(request);
  if (!sessionNonce) {
    return NextResponse.redirect(
      new URL("/orders/readonly-reauth?error=session_mismatch", request.url),
      302
    );
  }

  try {
    const authorizationUrl = await getBaseReadonlyOAuthModule().createAuthorizationUrl({
      requestOrigin: new URL(request.url).origin,
      sessionNonce,
    });
    return NextResponse.redirect(authorizationUrl, 302);
  } catch {
    return NextResponse.redirect(
      new URL("/orders/readonly-reauth?error=start_failed", request.url),
      302
    );
  }
}

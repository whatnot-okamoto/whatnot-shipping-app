import type { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { handleBaseReadonlyOAuthPreflight } from "@/lib/base-readonly-oauth-preflight";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  return handleBaseReadonlyOAuthPreflight({
    request,
    requireAuthenticated: requireAuth,
  });
}

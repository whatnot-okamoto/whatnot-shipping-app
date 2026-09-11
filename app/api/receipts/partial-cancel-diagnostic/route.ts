import { fetchOrderDetail } from "@/lib/base-api";
import { requireAuth } from "@/lib/auth";
import { analyzePartialCancellationV2 } from "@/lib/partial-cancel-diagnostic-v2";
import { createPartialCancelProductionDiagnosticPost } from "@/lib/partial-cancel-production-diagnostic";
import {
  isProductionRuntime,
  resolveRuntimeConfig,
} from "@/lib/runtime-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const post = createPartialCancelProductionDiagnosticPost({
  requireAuth,
  isProductionRuntime: () => isProductionRuntime(resolveRuntimeConfig()),
  fetchOrderDetail,
  analyzeOrder: analyzePartialCancellationV2,
});

export async function POST(request: Request): Promise<Response> {
  return post(request);
}

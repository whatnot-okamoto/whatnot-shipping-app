import type { PartialCancelDiagnostic } from "./partial-cancel-diagnostic-v2";

type ProductionDiagnosticDependencies = {
  requireAuth: (request: Request) => Promise<Response | null>;
  isProductionRuntime: () => boolean;
  fetchOrderDetail: (uniqueKey: string) => Promise<unknown>;
  analyzeOrder: (order: unknown) => PartialCancelDiagnostic;
};

const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ERROR_BAD_REQUEST = "入力内容を確認してください。";
const ERROR_GENERIC = "一部キャンセル診断を実行できませんでした。";
const ERROR_NOT_FOUND = "Not Found";

function applyPrivateNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Vary", "Cookie");
  return response;
}

function jsonResponse(body: unknown, status: number): Response {
  return applyPrivateNoStore(Response.json(body, { status }));
}

function readUniqueKey(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "unique_key") return null;
  if (typeof record.unique_key !== "string") return null;

  const uniqueKey = record.unique_key.trim();
  return ORDER_ID_PATTERN.test(uniqueKey) ? uniqueKey : null;
}

export function createPartialCancelProductionDiagnosticPost(
  dependencies: ProductionDiagnosticDependencies
): (request: Request) => Promise<Response> {
  return async function post(request: Request): Promise<Response> {
    let authError: Response | null;
    try {
      authError = await dependencies.requireAuth(request);
    } catch {
      return jsonResponse({ error: ERROR_GENERIC }, 500);
    }
    if (authError) return applyPrivateNoStore(authError);

    let productionRuntime = false;
    try {
      productionRuntime = dependencies.isProductionRuntime();
    } catch {
      productionRuntime = false;
    }
    if (!productionRuntime) {
      return jsonResponse({ error: ERROR_NOT_FOUND }, 404);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: ERROR_BAD_REQUEST }, 400);
    }

    const uniqueKey = readUniqueKey(body);
    if (!uniqueKey) {
      return jsonResponse({ error: ERROR_BAD_REQUEST }, 400);
    }

    try {
      const order = await dependencies.fetchOrderDetail(uniqueKey);
      const diagnostic = dependencies.analyzeOrder(order);
      return jsonResponse({ diagnostic }, 200);
    } catch {
      return jsonResponse({ error: ERROR_GENERIC }, 500);
    }
  };
}

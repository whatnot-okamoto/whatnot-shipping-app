// GET /api/orders
// dispatch_status: ordered の注文一覧を返す（ORDER-01 §3 取得層）
// BASE_API_TOKEN 未設定時はモックデータを返す

import { fetchOrderedOrders } from "@/lib/base-api";

export async function GET() {
  try {
    const orders = await fetchOrderedOrders();
    return Response.json({ orders, count: orders.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

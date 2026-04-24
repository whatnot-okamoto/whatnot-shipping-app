// POST /api/orders/init
// BASE API から注文を取得し、U1・U2・U4 を Upstash に初期化する。
//
// base-api.ts と order-store.ts は直接連携しない。
// このRoute Handler が橋渡しする（責務の分離）。

import { fetchOrderedOrders } from "@/lib/base-api";
import { initializeOrderData } from "@/lib/order-store";

export async function POST() {
  try {
    const orders = await fetchOrderedOrders();
    const result = await initializeOrderData(orders);
    return Response.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

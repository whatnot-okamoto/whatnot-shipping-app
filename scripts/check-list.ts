// GET /api/orders/list 確認スクリプト（remark 伏せ）
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const VERCEL_URL = "https://whatnot-shipping-app.vercel.app";

async function main() {
  const res = await fetch(`${VERCEL_URL}/api/orders/list`);
  const d = await res.json() as {
    success: boolean;
    status: string;
    session: Record<string, unknown>;
    orders: Array<Record<string, unknown>>;
    meta: Record<string, unknown>;
  };

  console.log("=== /api/orders/list 確認 ===");
  console.log("success:", d.success);
  console.log("status:", d.status);
  console.log("orders 件数:", d.orders.length);
  console.log("meta:", JSON.stringify(d.meta));
  console.log("session:", JSON.stringify(d.session));

  const orders = d.orders;

  // needs_initialization
  const ni = orders.filter((o) => o.needs_initialization);
  console.log(`\nneeds_initialization=true: ${ni.length}件`);

  // has_multiple_shipping_lines
  const multi = orders.filter((o) => o.has_multiple_shipping_lines);
  console.log(`has_multiple_shipping_lines=true: ${multi.length}件 →`, multi.map((o) => o.unique_key));

  // has_unknown_shipping_method
  const unknown = orders.filter((o) => o.has_unknown_shipping_method);
  console.log(`has_unknown_shipping_method=true: ${unknown.length}件`);

  // selectable / disabled_reason
  const notSel = orders.filter((o) => !o.selectable_for_session);
  console.log(`\nselectable_for_session=false: ${notSel.length}件`);
  const reasons: Record<string, number> = {};
  for (const o of notSel) {
    const r = String(o.disabled_reason);
    reasons[r] = (reasons[r] ?? 0) + 1;
  }
  console.log("disabled_reason 集計:", JSON.stringify(reasons, null, 2));

  // orders[0] の主要フィールド（remark 伏せ）
  const o0 = { ...orders[0] };
  o0.remark = o0.remark ? "【伏せ】" : "";
  console.log("\n--- orders[0] サンプルフィールド ---");
  const fields = [
    "unique_key", "receiver_name", "order_date", "shipping_method_name",
    "shipping_fee", "shipping_category", "item_count", "items_summary",
    "carrier", "hold_flag", "cancelled_flag", "bundle_group_id",
    "bundle_enabled", "picking_status", "needs_initialization",
    "has_multiple_shipping_lines", "has_unknown_shipping_method",
    "selectable_for_session", "disabled_reason",
  ];
  for (const k of fields) {
    console.log(`  ${k}: ${JSON.stringify(o0[k])}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// selectable_for_session=true の注文から bundle_group_id を1件取得
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  const res = await fetch("https://whatnot-shipping-app.vercel.app/api/orders/list");
  const d = await res.json() as { orders: Array<{ selectable_for_session: boolean; bundle_group_id: string; unique_key: string }> };
  const sel = d.orders.filter(o => o.selectable_for_session);
  console.log("selectable 件数:", sel.length);
  if (sel.length > 0) {
    console.log("bundle_group_id:", sel[0].bundle_group_id);
    console.log("unique_key:", sel[0].unique_key);
  }
}
main().catch(e => { console.error(e); process.exit(1); });

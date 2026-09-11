import { FIXTURE_DATA } from "../../lib/pdf-fixture-data.ts";

export const COMPOSITE_EXPECTED_AMOUNTS = Object.freeze({
  itemsSubtotal: 4360,
  shippingFee: 770,
  codFee: 330,
  total: 5330,
  hasReducedRateItem: true,
  taxRows: [
    { rate: 8, itemsSubtotal: 2160, includedTax: 160 },
    { rate: 10, itemsSubtotal: 2200, includedTax: 200 },
  ],
});

export function createCompositeAmountFixture() {
  const entry = structuredClone(FIXTURE_DATA["F-04"]);
  const order = entry.order;
  order.unique_key = "FIXTURE-COMPOSITE-PARTIAL-CANCEL";
  order.dispatch_status = "dispatched";
  order.dispatched = order.ordered + 3600;
  order.cancelled = order.ordered + 1800;
  order.cod_fee = 330;
  order.total = COMPOSITE_EXPECTED_AMOUNTS.total;
  order.order_items = [
    {
      order_item_id: 1601,
      item_id: 160100,
      variation_id: 0,
      title: "軽減税率テスト商品",
      barcode: "4900000001601",
      variation: "",
      variation_identifier: "",
      amount: 2,
      price: 1080,
      total: 2160,
      item_total: 2160,
      option_total: 0,
      options: [],
      status: "ordered",
      consumption_tax_rate: 8,
    },
    {
      order_item_id: 1602,
      item_id: 160200,
      variation_id: 0,
      title: "標準税率オプション付テスト商品",
      barcode: "4900000001602",
      variation: "オプション付",
      variation_identifier: "",
      amount: 1,
      price: 2000,
      total: 2200,
      item_total: 2000,
      option_total: 200,
      options: [{ price: 200, name: "テストオプション" }],
      status: "ordered",
      consumption_tax_rate: 10,
    },
    {
      order_item_id: 1603,
      item_id: 160300,
      variation_id: 0,
      title: "キャンセル済み非表示テスト商品",
      barcode: "4900000001603",
      variation: "",
      variation_identifier: "",
      amount: 1,
      price: 9999,
      total: 9999,
      item_total: 9999,
      option_total: 0,
      options: [],
      status: "cancelled",
      consumption_tax_rate: 10,
    },
  ];
  order.shipping_lines = [
    {
      order_item_ids: ["1601", "1602", "1603"],
      shipping_method: "まとめて配送",
      shipping_fee: COMPOSITE_EXPECTED_AMOUNTS.shippingFee,
    },
  ];
  order.order_discount = { discount: 100 };
  order.order_header_coin = { discount: 50 };
  order.order_amount_adjustment = { adjusted_amount: 20 };

  entry.orderState.unique_key = order.unique_key;
  entry.orderState.receipt_required = true;
  entry.orderState.receipt_name = "複合金額テスト御中";
  entry.orderState.receipt_note = "テスト商品代として";
  entry.orderState.cancelled_flag = true;
  return entry;
}

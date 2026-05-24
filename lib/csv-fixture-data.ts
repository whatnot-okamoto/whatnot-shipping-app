// TEST-CSV-FIXTURE-01
// CSV列構造・形式検証専用 fixture データ。
// BASE API・Upstash・activeセッションへの接続なし。
// 本番データを含まない。個人情報・実住所・実注文IDを含まない。

import type { BaseOrder } from "@/lib/base-api";
import type { CsvCarrier, CsvInputUnit } from "@/lib/csv-generator";

export type CsvFixturePattern = "CSV-F-01" | "CSV-F-02" | "CSV-F-03" | "CSV-F-04";

export const CSV_FIXTURE_PATTERN_IDS: CsvFixturePattern[] = [
  "CSV-F-01",
  "CSV-F-02",
  "CSV-F-03",
  "CSV-F-04",
];

export const CSV_FIXTURE_LABELS: Record<CsvFixturePattern, string> = {
  "CSV-F-01": "CSV-F-01: 佐川通常注文（宅配便・標準住所・1商品）",
  "CSV-F-02": "CSV-F-02: ヤマト宅急便通常注文（宅急便・標準住所・1商品）",
  "CSV-F-03": "CSV-F-03: ネコポス通常注文（標準住所・1商品）",
  "CSV-F-04": "CSV-F-04: 佐川別送注文（purchaser≠order_receiver・col.18〜22確認用）",
};

export type CsvFixtureEntry = {
  order: BaseOrder;
  carrier: CsvCarrier;
};

// ordered 固定値: 2026-01-15 12:00:00 JST = 2026-01-15 03:00:00 UTC
const FIXTURE_ORDERED = 1768446000;

// ============================================================================
// CSV-F-01: 佐川通常注文（宅配便・標準住所・1商品）
// ============================================================================
const orderCsvF01: BaseOrder = {
  unique_key: "TEST_CSV_F01",
  ordered: FIXTURE_ORDERED,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 0,
  cod_fee: 0,
  total: 2200,
  last_name: "テスト",
  first_name: "一郎",
  zip_code: "100-0001",
  prefecture: "東京都",
  address: "千代田区テスト町一丁目二番三号",
  address2: "",
  tel: "000-0000-0101",
  mail_address: "test-csv-f01@example.com",
  remark: "",
  modified: FIXTURE_ORDERED,
  terminated: false,
  order_receiver: {
    last_name: "テスト",
    first_name: "一郎",
    zip_code: "100-0001",
    prefecture: "東京都",
    address: "千代田区テスト町一丁目二番三号",
    address2: "",
    tel: "000-0000-0101",
    country: "",
    country_code: "",
  },
  order_items: [
    {
      order_item_id: 10001,
      item_id: 1000100,
      variation_id: 0,
      title: "テストデッキ（CSV-F-01佐川確認用）",
      barcode: "4900000010001",
      variation: "",
      variation_identifier: "",
      amount: 1,
      price: 2200,
      status: "ordered",
      consumption_tax_rate: 10,
    },
  ],
  shipping_lines: [
    {
      order_item_ids: ["10001"],
      shipping_method: "佐川急便",
      shipping_fee: 0,
    },
  ],
};

// ============================================================================
// CSV-F-02: ヤマト宅急便通常注文（宅急便・標準住所・1商品）
// ============================================================================
const orderCsvF02: BaseOrder = {
  unique_key: "TEST_CSV_F02",
  ordered: FIXTURE_ORDERED,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 0,
  cod_fee: 0,
  total: 3300,
  last_name: "テスト",
  first_name: "二郎",
  zip_code: "530-0001",
  prefecture: "大阪府",
  address: "大阪市北区テスト町二丁目三番四号",
  address2: "",
  tel: "000-0000-0202",
  mail_address: "test-csv-f02@example.com",
  remark: "",
  modified: FIXTURE_ORDERED,
  terminated: false,
  order_receiver: null,
  order_items: [
    {
      order_item_id: 10002,
      item_id: 1000200,
      variation_id: 0,
      title: "テストTシャツ（CSV-F-02ヤマト確認用）",
      barcode: "4900000010002",
      variation: "",
      variation_identifier: "",
      amount: 1,
      price: 3300,
      status: "ordered",
      consumption_tax_rate: 10,
    },
  ],
  shipping_lines: [
    {
      order_item_ids: ["10002"],
      shipping_method: "宅急便",
      shipping_fee: 0,
    },
  ],
};

// ============================================================================
// CSV-F-03: ネコポス通常注文（標準住所・1商品）
// ============================================================================
const orderCsvF03: BaseOrder = {
  unique_key: "TEST_CSV_F03",
  ordered: FIXTURE_ORDERED,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 0,
  cod_fee: 0,
  total: 1100,
  last_name: "テスト",
  first_name: "三郎",
  zip_code: "460-0001",
  prefecture: "愛知県",
  address: "名古屋市中区テスト町三丁目四番五号",
  address2: "",
  tel: "000-0000-0303",
  mail_address: "test-csv-f03@example.com",
  remark: "",
  modified: FIXTURE_ORDERED,
  terminated: false,
  order_receiver: null,
  order_items: [
    {
      order_item_id: 10003,
      item_id: 1000300,
      variation_id: 0,
      title: "テストステッカー（CSV-F-03ネコポス確認用）",
      barcode: "4900000010003",
      variation: "",
      variation_identifier: "",
      amount: 1,
      price: 1100,
      status: "ordered",
      consumption_tax_rate: 10,
    },
  ],
  shipping_lines: [
    {
      order_item_ids: ["10003"],
      shipping_method: "ネコポス",
      shipping_fee: 0,
    },
  ],
};

// ============================================================================
// CSV-F-04: 佐川別送注文（purchaser と order_receiver が異なる）
// ============================================================================
const orderCsvF04: BaseOrder = {
  unique_key: "TEST_CSV_F04",
  ordered: FIXTURE_ORDERED,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 0,
  cod_fee: 0,
  total: 4400,
  last_name: "送り主",
  first_name: "太郎",
  zip_code: "150-0001",
  prefecture: "東京都",
  address: "渋谷区テスト町一丁目一番一号",
  address2: "",
  tel: "000-0000-0401",
  mail_address: "test-csv-f04@example.com",
  remark: "",
  modified: FIXTURE_ORDERED,
  terminated: false,
  order_receiver: {
    last_name: "受取",
    first_name: "花子",
    zip_code: "231-0001",
    prefecture: "神奈川県",
    address: "横浜市中区テスト町二丁目三番四号",
    address2: "",
    tel: "000-0000-0402",
    country: "",
    country_code: "",
  },
  order_items: [
    {
      order_item_id: 10004,
      item_id: 1000400,
      variation_id: 0,
      title: "テストデッキ（CSV-F-04佐川別送確認用）",
      barcode: "4900000010004",
      variation: "",
      variation_identifier: "",
      amount: 1,
      price: 4400,
      status: "ordered",
      consumption_tax_rate: 10,
    },
  ],
  shipping_lines: [
    {
      order_item_ids: ["10004"],
      shipping_method: "佐川急便",
      shipping_fee: 0,
    },
  ],
};

// ============================================================================
// fixture エントリーポイント
// ============================================================================

export const CSV_FIXTURE_DATA: Record<CsvFixturePattern, CsvFixtureEntry> = {
  "CSV-F-01": { order: orderCsvF01, carrier: "sagawa" },
  "CSV-F-02": { order: orderCsvF02, carrier: "yamato" },
  "CSV-F-03": { order: orderCsvF03, carrier: "nekopos" },
  "CSV-F-04": { order: orderCsvF04, carrier: "sagawa" },
};

/** fixture order から CsvInputUnit を生成する（1注文＝1単位）。 */
export function makeCsvFixtureUnit(order: BaseOrder): CsvInputUnit {
  return {
    bundleGroupId: order.unique_key,
    orders: [order],
  };
}

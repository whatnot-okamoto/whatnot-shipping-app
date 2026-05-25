// TEST-CSV-FIXTURE-01
// CSV列構造・形式検証専用 fixture データ。
// BASE API・Upstash・activeセッションへの接続なし。
// 本番データを含まない。個人情報・実住所・実注文IDを含まない。

import type { BaseOrder } from "@/lib/base-api";
import type { CsvCarrier, CsvInputUnit } from "@/lib/csv-generator";

export type CsvFixturePattern = "CSV-F-01" | "CSV-F-02" | "CSV-F-03" | "CSV-F-04" | "CSV-F-05" | "CSV-F-06" | "CSV-F-07" | "CSV-F-08" | "CSV-F-09" | "CSV-F-10" | "CSV-F-11";

export const CSV_FIXTURE_PATTERN_IDS: CsvFixturePattern[] = [
  "CSV-F-01",
  "CSV-F-02",
  "CSV-F-03",
  "CSV-F-04",
  "CSV-F-05",
  "CSV-F-06",
  "CSV-F-07",
  "CSV-F-08",
  "CSV-F-09",
  "CSV-F-10",
  "CSV-F-11",
];

export const CSV_FIXTURE_LABELS: Record<CsvFixturePattern, string> = {
  "CSV-F-01": "CSV-F-01: 佐川通常注文（宅配便・標準住所・1商品）",
  "CSV-F-02": "CSV-F-02: ヤマト宅急便通常注文（宅急便・標準住所・1商品）",
  "CSV-F-03": "CSV-F-03: ネコポス通常注文（標準住所・1商品）",
  "CSV-F-04": "CSV-F-04: 佐川別送注文（purchaser≠order_receiver・col.18〜22確認用）",
  "CSV-F-05": "CSV-F-05: 佐川・実在住所（公共施設）・標準",
  "CSV-F-06": "CSV-F-06: 佐川・col.7超過（address2長）・停止確認",
  "CSV-F-07": "CSV-F-07: 佐川・col.6超過（address市区町村長）・停止確認",
  "CSV-F-08": "CSV-F-08: 佐川・長い品名（P12安全停止発火確認）",
  "CSV-F-09": "CSV-F-09: ヤマト・col.12超過（prefecture+address全角換算33文字）・長住所確認",
  "CSV-F-10": "CSV-F-10: ヤマト・address2あり（col.13出力確認）・通常住所",
  "CSV-F-11": "CSV-F-11: ヤマト宅急便・実在住所＋長いaddress2（B2 col.13長文字確認）",
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
  order_receiver: {
    last_name: "テスト",
    first_name: "二郎",
    zip_code: "530-0001",
    prefecture: "大阪府",
    address: "大阪市北区テスト町二丁目三番四号",
    address2: "",
    tel: "000-0000-0202",
    country: "",
    country_code: "",
  },
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
  order_receiver: {
    last_name: "テスト",
    first_name: "三郎",
    zip_code: "460-0001",
    prefecture: "愛知県",
    address: "名古屋市中区テスト町三丁目四番五号",
    address2: "",
    tel: "000-0000-0303",
    country: "",
    country_code: "",
  },
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
// CSV-F-05: 佐川・実在住所（公共施設）・標準
// 住所：兵庫県三木市大村530（岡本さん指定住所。Claude Codeは住所を検索・推測・自選しない）
// col.5=兵庫県 / col.6=三木市(3文字) / col.7=大村530(3.5文字) ← いずれも16文字以内
// ============================================================================
const orderCsvF05: BaseOrder = {
  unique_key: "TEST_CSV_F05",
  ordered: FIXTURE_ORDERED,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 0,
  cod_fee: 0,
  total: 1500,
  last_name: "テスト",
  first_name: "五郎",
  zip_code: "673-0404",
  prefecture: "兵庫県",
  address: "三木市大村530",
  address2: "",
  tel: "000-0000-0505",
  mail_address: "test-csv-f05@example.com",
  remark: "",
  modified: FIXTURE_ORDERED,
  terminated: false,
  order_receiver: null,
  order_items: [
    {
      order_item_id: 10005,
      item_id: 1000500,
      variation_id: 0,
      title: "テストデッキ（CSV-F-05実在住所確認用）",
      barcode: "4900000010005",
      variation: "",
      variation_identifier: "",
      amount: 1,
      price: 1500,
      status: "ordered",
      consumption_tax_rate: 10,
    },
  ],
  shipping_lines: [
    {
      order_item_ids: ["10005"],
      shipping_method: "佐川急便",
      shipping_fee: 0,
    },
  ],
};

// ============================================================================
// CSV-F-06: 佐川・col.7超過（address2長）・停止確認
// col.7 = split.street("1番地"=2.5文字) + address2(20文字) = 22.5 > 16 → CsvGeneratorError
// col.6 = "千代田区" = 4文字（上限内）
// ============================================================================
const orderCsvF06: BaseOrder = {
  unique_key: "TEST_CSV_F06",
  ordered: FIXTURE_ORDERED,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 0,
  cod_fee: 0,
  total: 1500,
  last_name: "テスト",
  first_name: "六郎",
  zip_code: "100-0001",
  prefecture: "東京都",
  address: "千代田区1番地",
  address2: "テストテストテストテストマンションテスト",
  tel: "000-0000-0606",
  mail_address: "test-csv-f06@example.com",
  remark: "",
  modified: FIXTURE_ORDERED,
  terminated: false,
  order_receiver: null,
  order_items: [
    {
      order_item_id: 10006,
      item_id: 1000600,
      variation_id: 0,
      title: "テストデッキ（CSV-F-06col7超過確認用）",
      barcode: "4900000010006",
      variation: "",
      variation_identifier: "",
      amount: 1,
      price: 1500,
      status: "ordered",
      consumption_tax_rate: 10,
    },
  ],
  shipping_lines: [
    {
      order_item_ids: ["10006"],
      shipping_method: "佐川急便",
      shipping_fee: 0,
    },
  ],
};

// ============================================================================
// CSV-F-07: 佐川・col.6超過（address市区町村長）・停止確認
// address の市区町村部分: "テストテストテストテストテスト超長市" = 18文字 > 16 → CsvGeneratorError
// col.7 = "1番地" = 2.5文字（上限内）
// ============================================================================
const orderCsvF07: BaseOrder = {
  unique_key: "TEST_CSV_F07",
  ordered: FIXTURE_ORDERED,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 0,
  cod_fee: 0,
  total: 1500,
  last_name: "テスト",
  first_name: "七郎",
  zip_code: "100-0001",
  prefecture: "東京都",
  address: "テストテストテストテストテスト超長市1番地",
  address2: "",
  tel: "000-0000-0707",
  mail_address: "test-csv-f07@example.com",
  remark: "",
  modified: FIXTURE_ORDERED,
  terminated: false,
  order_receiver: null,
  order_items: [
    {
      order_item_id: 10007,
      item_id: 1000700,
      variation_id: 0,
      title: "テストデッキ（CSV-F-07col6超過確認用）",
      barcode: "4900000010007",
      variation: "",
      variation_identifier: "",
      amount: 1,
      price: 1500,
      status: "ordered",
      consumption_tax_rate: 10,
    },
  ],
  shipping_lines: [
    {
      order_item_ids: ["10007"],
      shipping_method: "佐川急便",
      shipping_fee: 0,
    },
  ],
};

// ============================================================================
// CSV-F-08: 佐川・長い品名（P12安全停止発火確認）
// title: 全角31文字 → buildSagawaProductName の countZenkaku(productName) > 30 でエラー
// ============================================================================
const orderCsvF08: BaseOrder = {
  unique_key: "TEST_CSV_F08",
  ordered: FIXTURE_ORDERED,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 0,
  cod_fee: 0,
  total: 1500,
  last_name: "テスト",
  first_name: "八郎",
  zip_code: "100-0001",
  prefecture: "東京都",
  address: "千代田区テスト町一丁目二番三号",
  address2: "",
  tel: "000-0000-0808",
  mail_address: "test-csv-f08@example.com",
  remark: "",
  modified: FIXTURE_ORDERED,
  terminated: false,
  order_receiver: null,
  order_items: [
    {
      order_item_id: 10008,
      item_id: 1000800,
      variation_id: 0,
      title: "テスト超長品名テスト超長品名テスト超長品名テスト超長品名テスト",
      barcode: "4900000010008",
      variation: "",
      variation_identifier: "",
      amount: 1,
      price: 1500,
      status: "ordered",
      consumption_tax_rate: 10,
    },
  ],
  shipping_lines: [
    {
      order_item_ids: ["10008"],
      shipping_method: "佐川急便",
      shipping_fee: 0,
    },
  ],
};

// ============================================================================
// CSV-F-09: ヤマト・長住所（B2 col.12 全角換算33文字）
// col.12 = prefecture("東京都" 3文字) + address(30文字) = 33文字 → 32文字超
// address2は空文字。order_receiver はpurchaserと同一（通常注文）
// ============================================================================
const orderCsvF09: BaseOrder = {
  unique_key: "TEST_CSV_F09",
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
  first_name: "九郎",
  zip_code: "100-0001",
  prefecture: "東京都",
  address: "テスト市テスト区テスト町一丁目二番三号テストテストマンション",
  address2: "",
  tel: "000-0000-0909",
  mail_address: "test-csv-f09@example.com",
  remark: "",
  modified: FIXTURE_ORDERED,
  terminated: false,
  order_receiver: {
    last_name: "テスト",
    first_name: "九郎",
    zip_code: "100-0001",
    prefecture: "東京都",
    address: "テスト市テスト区テスト町一丁目二番三号テストテストマンション",
    address2: "",
    tel: "000-0000-0909",
    country: "",
    country_code: "",
  },
  order_items: [
    {
      order_item_id: 10009,
      item_id: 1000900,
      variation_id: 0,
      title: "テストデッキ（CSV-F-09ヤマト長住所確認用）",
      barcode: "4900000010009",
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
      order_item_ids: ["10009"],
      shipping_method: "宅急便",
      shipping_fee: 0,
    },
  ],
};

// ============================================================================
// CSV-F-10: ヤマト・address2あり（B2 col.13 出力確認）
// col.12 = prefecture("大阪府" 3文字) + address(16文字) = 19文字 → 32文字以内
// col.13 = address2("テストマンション101号室") → B2 Cloud上での認識・表示挙動を確認
// order_receiver はpurchaserと同一（通常注文）
// ============================================================================
const orderCsvF10: BaseOrder = {
  unique_key: "TEST_CSV_F10",
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
  first_name: "十郎",
  zip_code: "530-0001",
  prefecture: "大阪府",
  address: "大阪市北区テスト町三丁目五番六号",
  address2: "テストマンション101号室",
  tel: "000-0000-1010",
  mail_address: "test-csv-f10@example.com",
  remark: "",
  modified: FIXTURE_ORDERED,
  terminated: false,
  order_receiver: {
    last_name: "テスト",
    first_name: "十郎",
    zip_code: "530-0001",
    prefecture: "大阪府",
    address: "大阪市北区テスト町三丁目五番六号",
    address2: "テストマンション101号室",
    tel: "000-0000-1010",
    country: "",
    country_code: "",
  },
  order_items: [
    {
      order_item_id: 10010,
      item_id: 1001000,
      variation_id: 0,
      title: "テストデッキ（CSV-F-10ヤマトaddress2確認用）",
      barcode: "4900000010010",
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
      order_item_ids: ["10010"],
      shipping_method: "宅急便",
      shipping_fee: 0,
    },
  ],
};

// ============================================================================
// CSV-F-11: ヤマト宅急便・実在住所＋長いaddress2（B2 col.13長文字確認）
// 住所：兵庫県三木市大村530（岡本さん指定住所。Claude Codeは住所を検索・推測・自選しない）
// address2: テストマンション壱番館ロング名称サンプル棟イースト１０１号室（全角30文字）
// col.12 = prefecture("兵庫県" 3文字) + address("三木市大村530" 7文字) = 10文字 → 32文字以内
// col.13 = address2（全角30文字） → B2 Cloud上での長文字認識・表示挙動を確認
// order_receiver はpurchaserと同一（通常注文）
// ============================================================================
const orderCsvF11: BaseOrder = {
  unique_key: "TEST_CSV_F11",
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
  first_name: "十一郎",
  zip_code: "673-0404",
  prefecture: "兵庫県",
  address: "三木市大村530",
  address2: "テストマンション壱番館ロング名称サンプル棟イースト１０１号室",
  tel: "000-0000-1111",
  mail_address: "test-csv-f11@example.com",
  remark: "",
  modified: FIXTURE_ORDERED,
  terminated: false,
  order_receiver: {
    last_name: "テスト",
    first_name: "十一郎",
    zip_code: "673-0404",
    prefecture: "兵庫県",
    address: "三木市大村530",
    address2: "テストマンション壱番館ロング名称サンプル棟イースト１０１号室",
    tel: "000-0000-1111",
    country: "",
    country_code: "",
  },
  order_items: [
    {
      order_item_id: 10011,
      item_id: 1001100,
      variation_id: 0,
      title: "テストデッキ（CSV-F-11ヤマトaddress2長文字確認用）",
      barcode: "4900000010011",
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
      order_item_ids: ["10011"],
      shipping_method: "宅急便",
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
  "CSV-F-05": { order: orderCsvF05, carrier: "sagawa" },
  "CSV-F-06": { order: orderCsvF06, carrier: "sagawa" },
  "CSV-F-07": { order: orderCsvF07, carrier: "sagawa" },
  "CSV-F-08": { order: orderCsvF08, carrier: "sagawa" },
  "CSV-F-09": { order: orderCsvF09, carrier: "yamato" },
  "CSV-F-10": { order: orderCsvF10, carrier: "yamato" },
  "CSV-F-11": { order: orderCsvF11, carrier: "yamato" },
};

/** fixture order から CsvInputUnit を生成する（1注文＝1単位）。 */
export function makeCsvFixtureUnit(order: BaseOrder): CsvInputUnit {
  return {
    bundleGroupId: order.unique_key,
    orders: [order],
  };
}

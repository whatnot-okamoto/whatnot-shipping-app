// TEST-PDF-FIXTURE-01
// PDF帳票レイアウト検証専用 fixture データ。
// BASE API・Upstash・activeセッションへの接続なし。
// 本番データを含まない。個人情報を含まない。

import type { BaseOrder } from "@/lib/base-api";
import type { U1Data } from "@/lib/order-store";

export type FixturePattern =
  | "F-01"
  | "F-02"
  | "F-03"
  | "F-04"
  | "F-05"
  | "F-06"
  | "F-07"
  | "F-08"
  | "F-09"
  | "F-10"
  | "F-11"
  | "F-12"
  | "F-13"
  | "F-15";

export const FIXTURE_PATTERN_IDS: FixturePattern[] = [
  "F-01",
  "F-02",
  "F-03",
  "F-04",
  "F-05",
  "F-06",
  "F-07",
  "F-08",
  "F-09",
  "F-10",
  "F-11",
  "F-12",
  "F-13",
  "F-15",
];

export const FIXTURE_LABELS: Record<FixturePattern, string> = {
  "F-01": "F-01: 標準注文（通常・1商品）",
  "F-02": "F-02: 別送注文（showBilling=true）",
  "F-03": "F-03: 別送注文（注文主zip_code空）",
  "F-04": "F-04: 領収書あり（標準注文）",
  "F-05": "F-05: 商品数が多い注文（改ページ発生）",
  "F-06": "F-06: 長い商品名（100文字超）",
  "F-07": "F-07: 長いお届け先住所（3行折り返し）",
  "F-08": "F-08: 納品書複数ページ＋領収書あり",
  "F-09": "F-09: 領収書あり（宛名空欄）",
  "F-10": "F-10: 別送注文＋領収書あり（宛名あり）",
  "F-11": "F-11: 別送注文（注文主住所が長い・2〜3行折り返し確認）",
  "F-12": "F-12: お届け先住所が4行分超・3行制限挙動確認",
  "F-13": "F-13: 長いバリエーション名・右列縦位置確認",
  "F-15": "F-15: PAYMENT-LABEL-UNKNOWN-01候補 警告表示検証用（未知payment値）",
};

// ============================================================================
// 共通ヘルパー
// ============================================================================

function makeOrderState(
  uniqueKey: string,
  overrides: Partial<U1Data> = {}
): U1Data {
  return {
    unique_key: uniqueKey,
    hold_flag: false,
    hold_reason: "",
    carrier: "",
    receipt_required: false,
    receipt_name: "",
    receipt_note: "",
    app_memo: "",
    cancelled_flag: false,
    ...overrides,
  };
}

/** 単一商品アイテム（全商品 consumption_tax_rate: 10 固定） */
function makeItem(
  id: number,
  title: string,
  price: number,
  amount = 1,
  overrides: {
    barcode?: string;
    variation?: string;
    variation_identifier?: string;
    variation_id?: number;
    item_id?: number;
    status?: string;
  } = {}
) {
  return {
    order_item_id: id,
    item_id: overrides.item_id ?? id * 100,
    variation_id: overrides.variation_id ?? 0,
    title,
    barcode: overrides.barcode ?? "",
    variation: overrides.variation ?? "",
    variation_identifier: overrides.variation_identifier ?? "",
    amount,
    price,
    status: overrides.status ?? "ordered",
    consumption_tax_rate: 10,
  };
}

/** 標準配送ライン（送料あり） */
const shippingWithFee = [
  {
    order_item_ids: ["1"],
    shipping_method: "宅急便",
    shipping_fee: 770,
  },
];

/** 送料無料配送ライン */
const shippingFree = [
  {
    order_item_ids: ["1"],
    shipping_method: "メール便",
    shipping_fee: 0,
  },
];

// ============================================================================
// F-01: 標準注文（showBilling=false, 1商品, 送料あり, 領収書なし）
// ============================================================================
const orderF01: BaseOrder = {
  unique_key: "FIXTURE-F01-TEST",
  ordered: 1748000000,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "paypay",
  shipping_method: null,
  shipping_fee: 770,
  cod_fee: 0,
  total: 3300,
  last_name: "テスト",
  first_name: "太郎",
  zip_code: "100-0001",
  prefecture: "東京都",
  address: "千代田区テスト町一丁目二番三号",
  address2: "",
  tel: "000-0000-0001",
  mail_address: "test01@example.com",
  remark: "",
  modified: 1748000000,
  terminated: false,
  order_receiver: null,
  order_items: [
    makeItem(1, "テスト商品A（F-01標準注文確認用）", 2530, 1, {
      barcode: "4900000000001",
    }),
  ],
  shipping_lines: shippingWithFee,
};

// ============================================================================
// F-02: 別送注文（showBilling=true, order_receiver あり, zip_code あり）
// お届け先と注文主が異なる → showBilling=true
// ============================================================================
const orderF02: BaseOrder = {
  unique_key: "FIXTURE-F02-TEST",
  ordered: 1748000100,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 770,
  cod_fee: 0,
  total: 5500,
  last_name: "テスト",
  first_name: "太郎",
  zip_code: "100-0001",
  prefecture: "東京都",
  address: "千代田区テスト町一丁目二番三号",
  address2: "",
  tel: "000-0000-0002",
  mail_address: "test02@example.com",
  remark: "",
  modified: 1748000100,
  terminated: false,
  order_receiver: {
    last_name: "テスト",
    first_name: "花子",
    zip_code: "530-0001",
    prefecture: "大阪府",
    address: "大阪市北区テスト区テスト町四丁目五番六号",
    address2: "テストビル三階",
    tel: "000-0000-0022",
    country: "Japan",
    country_code: "JP",
  },
  order_items: [
    makeItem(2, "テスト商品B（F-02別送注文確認用）", 4730, 1, {
      barcode: "4900000000002",
    }),
  ],
  shipping_lines: shippingWithFee,
};

// ============================================================================
// F-03: 別送注文（showBilling=true, 注文主 zip_code: "" 空文字）
// 注文主欄の郵便番号行が非表示になることを確認するパターン
// ============================================================================
const orderF03: BaseOrder = {
  unique_key: "FIXTURE-F03-TEST",
  ordered: 1748000200,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "paypay",
  shipping_method: null,
  shipping_fee: 0,
  cod_fee: 0,
  total: 2200,
  last_name: "テスト",
  first_name: "次郎",
  zip_code: "",
  prefecture: "愛知県",
  address: "名古屋市中区テスト町七丁目八番九号",
  address2: "",
  tel: "000-0000-0003",
  mail_address: "test03@example.com",
  remark: "",
  modified: 1748000200,
  terminated: false,
  order_receiver: {
    last_name: "テスト",
    first_name: "三郎",
    zip_code: "060-0001",
    prefecture: "北海道",
    address: "札幌市中央区テスト一条テスト丁目テスト番地",
    address2: "",
    tel: "000-0000-0033",
    country: "Japan",
    country_code: "JP",
  },
  order_items: [
    makeItem(3, "テスト商品C（F-03別送zip空確認用）", 2200, 1, {
      barcode: "4900000000003",
    }),
  ],
  shipping_lines: shippingFree,
};

// ============================================================================
// F-04: 領収書あり（showBilling=false, receipt_required=true）
// ============================================================================
const orderF04: BaseOrder = {
  unique_key: "FIXTURE-F04-TEST",
  ordered: 1748000300,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "paypay",
  shipping_method: null,
  shipping_fee: 550,
  cod_fee: 0,
  total: 4400,
  last_name: "テスト",
  first_name: "四郎",
  zip_code: "460-0001",
  prefecture: "愛知県",
  address: "名古屋市中区テスト町一丁目一番一号",
  address2: "",
  tel: "000-0000-0004",
  mail_address: "test04@example.com",
  remark: "",
  modified: 1748000300,
  terminated: false,
  order_receiver: null,
  order_items: [
    makeItem(4, "テスト商品D（F-04領収書あり確認用）", 3850, 1, {
      barcode: "4900000000004",
    }),
  ],
  shipping_lines: [
    {
      order_item_ids: ["4"],
      shipping_method: "宅急便",
      shipping_fee: 550,
    },
  ],
};

// ============================================================================
// F-05: 商品数が多い注文（改ページ発生確認, 25商品）
// A4縦1ページに約23〜24商品が収まる設計のため、25件で改ページが発生する
// ============================================================================
const itemsF05 = Array.from({ length: 25 }, (_, i) =>
  makeItem(
    500 + i,
    `テスト商品${String(i + 1).padStart(2, "0")}（F-05改ページ確認用）`,
    1100,
    1,
    { barcode: `490000000${String(i + 1).padStart(4, "0")}` }
  )
);

const orderF05: BaseOrder = {
  unique_key: "FIXTURE-F05-TEST",
  ordered: 1748000400,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "paypay",
  shipping_method: null,
  shipping_fee: 770,
  cod_fee: 0,
  total: 28270,
  last_name: "テスト",
  first_name: "五郎",
  zip_code: "150-0001",
  prefecture: "東京都",
  address: "渋谷区テスト町五丁目五番五号",
  address2: "",
  tel: "000-0000-0005",
  mail_address: "test05@example.com",
  remark: "",
  modified: 1748000400,
  terminated: false,
  order_receiver: null,
  order_items: itemsF05,
  shipping_lines: [
    {
      order_item_ids: itemsF05.map((it) => String(it.order_item_id)),
      shipping_method: "宅急便",
      shipping_fee: 770,
    },
  ],
};

// ============================================================================
// F-06: 長い商品名（100文字超, wrapText 折り返し確認）
// ============================================================================
const longTitle =
  "テスト商品名（F-06：長い商品名折り返し確認用サンプルデータ）テストテストテストテストテストテストテストテストテストテストテストテストテストテストテストテスト";
// length確認: 約80文字。さらに追加して100文字超にする
const longTitleOver100 =
  longTitle + "テストテストテストテストテストテストテスト（END）";

const orderF06: BaseOrder = {
  unique_key: "FIXTURE-F06-TEST",
  ordered: 1748000500,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "paypay",
  shipping_method: null,
  shipping_fee: 770,
  cod_fee: 0,
  total: 2970,
  last_name: "テスト",
  first_name: "六郎",
  zip_code: "550-0001",
  prefecture: "大阪府",
  address: "大阪市西区テスト町六丁目六番六号",
  address2: "",
  tel: "000-0000-0006",
  mail_address: "test06@example.com",
  remark: "",
  modified: 1748000500,
  terminated: false,
  order_receiver: null,
  order_items: [
    makeItem(6, longTitleOver100, 2200, 1, {
      barcode: "4900000000006",
      variation: "カラー：テスト / サイズ：F",
    }),
  ],
  shipping_lines: [
    {
      order_item_ids: ["6"],
      shipping_method: "宅急便",
      shipping_fee: 770,
    },
  ],
};

// ============================================================================
// F-07: 長いお届け先住所（3行折り返し確認）
// leftMaxW = CONTENT_WIDTH/2 - 10 ≈ 247pt。NotoSansJP 8pt で1行約30文字。
// 3行超を発生させるため prefecture+address+address2 で80文字超を設定する。
// ============================================================================
const orderF07: BaseOrder = {
  unique_key: "FIXTURE-F07-TEST",
  ordered: 1748000600,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "paypay",
  shipping_method: null,
  shipping_fee: 770,
  cod_fee: 0,
  total: 3300,
  last_name: "テスト",
  first_name: "七郎",
  zip_code: "100-0001",
  prefecture: "東京都",
  address: "千代田区大手町テスト一丁目二番三号テストビルディング本館テストフロア",
  address2: "五〇一号室テスト部テスト担当者宛テスト長住所確認用サンプル",
  tel: "000-0000-0007",
  mail_address: "test07@example.com",
  remark: "",
  modified: 1748000600,
  terminated: false,
  order_receiver: null,
  order_items: [
    makeItem(7, "テスト商品G（F-07長住所折り返し確認用）", 2530, 1, {
      barcode: "4900000000007",
    }),
  ],
  shipping_lines: [
    {
      order_item_ids: ["7"],
      shipping_method: "宅急便",
      shipping_fee: 770,
    },
  ],
};

// ============================================================================
// F-08: 納品書複数ページ＋領収書あり（F-05と同数の25商品 + receipt_required=true）
// ============================================================================
const itemsF08 = Array.from({ length: 25 }, (_, i) =>
  makeItem(
    800 + i,
    `テスト商品${String(i + 1).padStart(2, "0")}（F-08複数ページ＋領収書確認用）`,
    1100,
    1,
    { barcode: `490000008${String(i + 1).padStart(4, "0")}` }
  )
);

const orderF08: BaseOrder = {
  unique_key: "FIXTURE-F08-TEST",
  ordered: 1748000700,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "paypay",
  shipping_method: null,
  shipping_fee: 770,
  cod_fee: 0,
  total: 28270,
  last_name: "テスト",
  first_name: "八郎",
  zip_code: "220-0001",
  prefecture: "神奈川県",
  address: "横浜市西区テスト町八丁目八番八号",
  address2: "",
  tel: "000-0000-0008",
  mail_address: "test08@example.com",
  remark: "",
  modified: 1748000700,
  terminated: false,
  order_receiver: null,
  order_items: itemsF08,
  shipping_lines: [
    {
      order_item_ids: itemsF08.map((it) => String(it.order_item_id)),
      shipping_method: "宅急便",
      shipping_fee: 770,
    },
  ],
};

// ============================================================================
// F-10: 別送注文＋領収書あり（宛名あり）
// showBilling=true（purchaser と receiver の7フィールドが全て異なる）
// receipt_required=true, receipt_name="テスト注文主"（「様」なし）
// PDF-RECEIPT-BILLING-SAMA-01 確認用
// ============================================================================
const orderF10: BaseOrder = {
  unique_key: "FIXTURE-F10-TEST",
  ordered: 1748000900,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "paypay",
  shipping_method: null,
  shipping_fee: 770,
  cod_fee: 0,
  total: 6050,
  last_name: "テスト購入者",
  first_name: "太郎",
  zip_code: "650-0001",
  prefecture: "兵庫県",
  address: "神戸市中央区サンプル町1-1",
  address2: "購入者ビル101",
  tel: "090-0000-1111",
  mail_address: "purchaser@example.com",
  remark: "",
  modified: 1748000900,
  terminated: false,
  order_receiver: {
    last_name: "テスト受取人",
    first_name: "花子",
    zip_code: "530-0001",
    prefecture: "大阪府",
    address: "大阪市北区サンプル2-2",
    address2: "受取人マンション202",
    tel: "080-0000-2222",
    country: "Japan",
    country_code: "JP",
  },
  order_items: [
    makeItem(101, "テスト商品A（F-10別送＋領収書確認用）", 3300, 1, {
      barcode: "4900000000101",
    }),
    makeItem(102, "テスト商品B（F-10別送＋領収書確認用）", 1980, 1, {
      barcode: "4900000000102",
    }),
  ],
  shipping_lines: [
    {
      order_item_ids: ["101", "102"],
      shipping_method: "宅急便",
      shipping_fee: 770,
    },
  ],
};

// ============================================================================
// F-11: 別送注文・注文主住所が長い（PDF-ADDRESS-TRUNCATE-01 後続）
// showBilling=true（purchaser と order_receiver が異なる）
// purchaser の prefecture+address の合計 42文字（全角40文字超）
// ============================================================================
const orderF11: BaseOrder = {
  unique_key: "FIXTURE-F11-TEST",
  ordered: 1748001000,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 770,
  cod_fee: 0,
  total: 4070,
  last_name: "テスト購入者",
  first_name: "太郎",
  zip_code: "399-9301",
  prefecture: "長野県",
  address: "北安曇郡白馬村テスト町一丁目二番三号テストビルディング東館テストフロア長住所確認用",
  address2: "",
  tel: "000-0000-0011",
  mail_address: "test11@example.com",
  remark: "",
  modified: 1748001000,
  terminated: false,
  order_receiver: {
    last_name: "テスト受取人",
    first_name: "花子",
    zip_code: "530-0001",
    prefecture: "大阪府",
    address: "大阪市北区テスト町四丁目五番六号",
    address2: "",
    tel: "000-0000-0111",
    country: "Japan",
    country_code: "JP",
  },
  order_items: [
    makeItem(111, "テスト商品（F-11別送注文主長住所確認用）", 3300, 1, {
      barcode: "4900000000111",
    }),
  ],
  shipping_lines: [
    {
      order_item_ids: ["111"],
      shipping_method: "宅急便",
      shipping_fee: 770,
    },
  ],
};

// ============================================================================
// F-12: お届け先住所が4行分超・3行制限挙動確認（PDF-ADDRESS-TRUNCATE-01 後続）
// order_receiver の prefecture+address+address2 合計 119文字（全角115〜120文字範囲内）
// limitWrappedLines(maxLines=3) による4行目以降の扱いを確認
// ============================================================================
const orderF12: BaseOrder = {
  unique_key: "FIXTURE-F12-TEST",
  ordered: 1748001100,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 770,
  cod_fee: 0,
  total: 3300,
  last_name: "テスト",
  first_name: "太郎",
  zip_code: "100-0001",
  prefecture: "東京都",
  address: "千代田区テスト町一丁目二番三号",
  address2: "",
  tel: "000-0000-0012",
  mail_address: "test12@example.com",
  remark: "",
  modified: 1748001100,
  terminated: false,
  order_receiver: {
    last_name: "テスト受取人",
    first_name: "花子",
    zip_code: "060-0001",
    prefecture: "北海道",
    address: "札幌市中央区テスト北一条テスト西二丁目テストビルディング北館テストフロアテスト部テスト区画長住所四行超確認用テスト号室",
    address2: "テスト担当者宛テスト長住所確認用サンプルデータフィクスチャ四行超折り返し確認テストデータ追加テキストテスト棟テスト",
    tel: "000-0000-0122",
    country: "Japan",
    country_code: "JP",
  },
  order_items: [
    makeItem(121, "テスト商品（F-12お届け先長住所四行超確認用）", 2530, 1, {
      barcode: "4900000000121",
    }),
  ],
  shipping_lines: [
    {
      order_item_ids: ["121"],
      shipping_method: "宅急便",
      shipping_fee: 770,
    },
  ],
};

// ============================================================================
// F-13: 長いバリエーション名（PDF-LAYOUT-02 再オープン条件）
// variation フィールドに全角52文字の長文を設定
// order_items 2種：バリエーションあり1件・バリエーションなし1件
// ============================================================================
const orderF13: BaseOrder = {
  unique_key: "FIXTURE-F13-TEST",
  ordered: 1748001200,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "creditcard",
  shipping_method: null,
  shipping_fee: 770,
  cod_fee: 0,
  total: 4950,
  last_name: "テスト",
  first_name: "太郎",
  zip_code: "100-0001",
  prefecture: "東京都",
  address: "千代田区テスト町一丁目二番三号",
  address2: "",
  tel: "000-0000-0013",
  mail_address: "test13@example.com",
  remark: "",
  modified: 1748001200,
  terminated: false,
  order_receiver: null,
  order_items: [
    makeItem(131, "テスト商品Ａ（F-13バリエーション長文確認用）", 2200, 1, {
      barcode: "4900000000131",
      variation: "テストバリエーション名長文確認用サイズカラー素材組み合わせパターン検証用長文テストサンプルデータ確認用",
    }),
    makeItem(132, "テスト商品Ｂ（F-13バリエーションなし確認用）", 1980, 1, {
      barcode: "4900000000132",
    }),
  ],
  shipping_lines: [
    {
      order_item_ids: ["131", "132"],
      shipping_method: "宅急便",
      shipping_fee: 770,
    },
  ],
};

// ============================================================================
// F-15: PAYMENT-LABEL-UNKNOWN-01候補 警告表示検証用
// payment 値に "test_unknown_payment"（PAYMENT_LABELS 未定義の架空生コード）を設定。
// 全商品 10%・領収書なし。X-Payment-Label-Unknown header 付与と UI 警告表示の確認用。
// ============================================================================
const orderF15: BaseOrder = {
  unique_key: "FIXTURE-F15-TEST",
  ordered: 1748001400,
  cancelled: null,
  dispatched: null,
  dispatch_status: "unsent",
  payment: "test_unknown_payment",
  shipping_method: null,
  shipping_fee: 770,
  cod_fee: 0,
  total: 3300,
  last_name: "テスト",
  first_name: "太郎",
  zip_code: "100-0001",
  prefecture: "東京都",
  address: "千代田区テスト町一丁目二番三号",
  address2: "",
  tel: "000-0000-0015",
  mail_address: "test15@example.com",
  remark: "",
  modified: 1748001400,
  terminated: false,
  order_receiver: null,
  order_items: [
    makeItem(151, "テスト商品A（F-15未知payment値警告確認用）", 2530, 1, {
      barcode: "4900000000151",
    }),
  ],
  shipping_lines: [
    {
      order_item_ids: ["151"],
      shipping_method: "宅急便",
      shipping_fee: 770,
    },
  ],
};

// ============================================================================
// fixture エントリーポイント
// ============================================================================

export type FixtureEntry = {
  order: BaseOrder;
  orderState: U1Data;
};

export const FIXTURE_DATA: Record<FixturePattern, FixtureEntry> = {
  "F-01": {
    order: orderF01,
    orderState: makeOrderState("FIXTURE-F01-TEST"),
  },
  "F-02": {
    order: orderF02,
    orderState: makeOrderState("FIXTURE-F02-TEST"),
  },
  "F-03": {
    order: orderF03,
    orderState: makeOrderState("FIXTURE-F03-TEST"),
  },
  "F-04": {
    order: orderF04,
    orderState: makeOrderState("FIXTURE-F04-TEST", {
      receipt_required: true,
      receipt_name: "テスト御中",
      receipt_note: "テスト商品代として",
    }),
  },
  "F-05": {
    order: orderF05,
    orderState: makeOrderState("FIXTURE-F05-TEST"),
  },
  "F-06": {
    order: orderF06,
    orderState: makeOrderState("FIXTURE-F06-TEST"),
  },
  "F-07": {
    order: orderF07,
    orderState: makeOrderState("FIXTURE-F07-TEST"),
  },
  "F-08": {
    order: orderF08,
    orderState: makeOrderState("FIXTURE-F08-TEST", {
      receipt_required: true,
      receipt_name: "テスト八郎",
      receipt_note: "テスト商品代として",
    }),
  },
  "F-09": {
    order: orderF04,
    orderState: makeOrderState("FIXTURE-F04-TEST", {
      receipt_required: true,
      receipt_name: "",
      receipt_note: "テスト商品代として",
    }),
  },
  "F-10": {
    order: orderF10,
    orderState: makeOrderState("FIXTURE-F10-TEST", {
      receipt_required: true,
      receipt_name: "テスト注文主",
      receipt_note: "",
    }),
  },
  "F-11": {
    order: orderF11,
    orderState: makeOrderState("FIXTURE-F11-TEST"),
  },
  "F-12": {
    order: orderF12,
    orderState: makeOrderState("FIXTURE-F12-TEST"),
  },
  "F-13": {
    order: orderF13,
    orderState: makeOrderState("FIXTURE-F13-TEST"),
  },
  "F-15": {
    order: orderF15,
    orderState: makeOrderState("FIXTURE-F15-TEST"),
  },
};

// CSV生成ロジック（D-3A実装）
// 対象キャリア：ヤマト宅急便・ネコポス（B2クラウド・42列）/ 佐川e飛伝III（74列）
// 文字コード：Shift-JIS（iconv-lite使用）
// 出力単位：U2（同梱群）ごとに1行。bundle_enabled=false時は注文ごとに1行。
// E-1補正メモ: 38列目・39列目は空欄。個口数は初期実装スコープ外（佐川42列目=固定"1"）。

import iconv from "iconv-lite";
import type { BaseOrder } from "@/lib/base-api";
import { isOrderReceiverValid } from "@/lib/base-api";
import {
  YAMATO_SENDER_TEL,
  YAMATO_SENDER_ZIP,
  YAMATO_SENDER_ADDRESS,
  YAMATO_SENDER_BLDG,
  YAMATO_SENDER_NAME,
  YAMATO_BILLING_CODE,
  YAMATO_BILLING_CLASS,
  YAMATO_FREIGHT_CODE,
  YAMATO_KEISHO,
} from "@/lib/shipping-csv-config";

// ============================================================================
// 型定義
// ============================================================================

export type CsvCarrier = "nekopos" | "yamato" | "sagawa";

/** CSV生成の入力単位（U2に対応）。bundle_expanded=trueの場合はU2から単独注文に展開済み。 */
export type CsvInputUnit = {
  bundleGroupId: string;
  orders: BaseOrder[];
};

/** CSV生成エラー（スタッフ向け日本語メッセージ付き）。 */
export class CsvGeneratorError extends Error {
  constructor(
    message: string,
    public readonly bundleGroupId: string
  ) {
    super(message);
    this.name = "CsvGeneratorError";
  }
}

// ============================================================================
// 定数
// ============================================================================

/** ヤマト/ネコポス B2クラウド 42列 ヘッダー */
const YAMATO_HEADER = [
  "お客様管理番号", "送り状種類", "クール区分", "伝票番号", "出荷予定日", "お届け予定日",
  "配達時間帯", "お届け先コード", "お届け先電話番号", "お届け先電話番号枝番",
  "お届け先郵便番号", "お届け先住所", "お届け先アパートマンション名",
  "お届け先会社・部門１", "お届け先会社・部門２", "お届け先名", "お届け先名(ｶﾅ)",
  "敬称", "ご依頼主コード", "ご依頼主電話番号", "ご依頼主電話番号枝番",
  "ご依頼主郵便番号", "ご依頼主住所", "ご依頼主建物名アパートマンション",
  "ご依頼主名", "ご依頼主名(ｶﾅ)", "品名コード１", "品名１", "品名コード２", "品名２",
  "荷扱い１", "荷扱い２", "記事", "ｺﾚｸﾄ代金引換額（税込）", "内消費税額等", "止置き",
  "営業所コード", "発行枚数", "個数口表示フラグ", "ご請求先顧客コード",
  "ご請求先分類コード", "運賃管理番号",
];

/** 佐川 e飛伝III 74列 ヘッダー */
const SAGAWA_HEADER = [
  "お届け先コード取得区分", "お届け先コード", "お届け先電話番号", "お届け先郵便番号",
  "お届け先住所１", "お届け先住所２", "お届け先住所３", "お届け先名称１", "お届け先名称２",
  "お客様管理番号", "お客様コード", "部署ご担当者コード取得区分", "部署ご担当者コード",
  "部署ご担当者名称", "荷送人電話番号", "ご依頼主コード取得区分", "ご依頼主コード",
  "ご依頼主電話番号", "ご依頼主郵便番号", "ご依頼主住所１", "ご依頼主住所２",
  "ご依頼主名称１", "ご依頼主名称２", "荷姿", "品名１", "品名２", "品名３", "品名４", "品名５",
  "荷札荷姿", "荷札品名１", "荷札品名２", "荷札品名３", "荷札品名４", "荷札品名５",
  "荷札品名６", "荷札品名７", "荷札品名８", "荷札品名９", "荷札品名１０", "荷札品名１１",
  "出荷個数", "スピード指定", "クール便指定", "配達日", "配達指定時間帯",
  "配達指定時間（時分）", "代引金額", "消費税", "決済種別", "保険金額", "指定シール１",
  "指定シール２", "指定シール３", "営業所受取", "ＳＲＣ区分", "営業所受取営業所コード",
  "元着区分", "メールアドレス", "ご不在時連絡先", "出荷日", "お問い合せ送り状No.",
  "出荷場印字区分", "集約解除指定", "編集０１", "編集０２", "編集０３", "編集０４", "編集０５",
  "編集０６", "編集０７", "編集０８", "編集０９", "編集１０",
];

// ============================================================================
// 文字数ユーティリティ
// ============================================================================

/**
 * 全角換算文字数を返す（全角=1, 半角=0.5）。
 * 半角: ASCII印字可能文字（U+0020-U+007E）および半角カタカナ（U+FF61-U+FF9F）。
 */
function countZenkaku(str: string): number {
  let count = 0;
  for (const char of str) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x0020 && code <= 0x007e) ||
      (code >= 0xff61 && code <= 0xff9f)
    ) {
      count += 0.5;
    } else {
      count += 1;
    }
  }
  return count;
}

// ============================================================================
// D案フォールバック（U2レベル判定）
// ============================================================================

/**
 * U2内の全注文の order_receiver 有効性を確認し、使用するソースを返す。
 * 全有効 → "receiver"
 * 全無効 → "purchaser"
 * 混在   → null（エラー）
 */
function getU2ReceiverSource(
  orders: BaseOrder[]
): "receiver" | "purchaser" | null {
  const validities = orders.map((o) => isOrderReceiverValid(o));
  if (validities.every((v) => v)) return "receiver";
  if (validities.every((v) => !v)) return "purchaser";
  return null;
}

/**
 * U2内の全注文の送り先情報が一致しているかを確認する。
 * source に応じて receiver/purchaser の6項目（氏名・電話・郵便番号・都道府県・住所・建物名）を比較する。
 * 1件でも不一致がある場合は CsvGeneratorError をスロー。
 * orders が1件のみの場合は比較不要のため即リターン。
 * エラーメッセージに個人情報（具体値）は含めない。
 */
function checkU2RecipientConsistency(
  orders: BaseOrder[],
  source: "receiver" | "purchaser",
  bundleGroupId: string,
  carrierLabel: string
): void {
  if (orders.length <= 1) return;

  const recipients = orders.map((o) => extractRecipient(o, source));
  const first = recipients[0];

  for (let i = 1; i < recipients.length; i++) {
    const r = recipients[i];
    if (
      r.fullName !== first.fullName ||
      (r.tel ?? "") !== (first.tel ?? "") ||
      r.zip !== first.zip ||
      r.prefecture !== first.prefecture ||
      r.addressStreet !== first.addressStreet ||
      (r.addressBuilding ?? "") !== (first.addressBuilding ?? "")
    ) {
      throw new CsvGeneratorError(
        `${carrierLabel}CSV（bundle_group_id: ${bundleGroupId}）の同梱グループ内で` +
          `送り先情報が一致しません。注文内容を確認してください。`,
        bundleGroupId
      );
    }
  }
}

/** 受け取り先情報を構造体として返す。source に応じて receiver/purchaser を使い分ける。 */
function extractRecipient(
  order: BaseOrder,
  source: "receiver" | "purchaser"
): {
  fullName: string;
  tel: string;
  zip: string;
  prefecture: string;
  addressStreet: string;
  addressBuilding: string;
} {
  if (source === "receiver") {
    const r = order.order_receiver!;
    return {
      fullName: `${r.last_name} ${r.first_name}`,
      tel: r.tel,
      zip: r.zip_code,
      prefecture: r.prefecture,
      addressStreet: r.address,
      addressBuilding: r.address2 ?? "",
    };
  }
  return {
    fullName: `${order.last_name} ${order.first_name}`,
    tel: order.tel,
    zip: order.zip_code,
    prefecture: order.prefecture,
    addressStreet: order.address,
    addressBuilding: order.address2 ?? "",
  };
}

// ============================================================================
// 住所分割（佐川用：都道府県/市区町村/番地・建物名）
// ============================================================================

/**
 * address フィールド（都道府県を含まない）を市区町村と番地部分に分割する。
 * BASE公式CSV分割構造踏襲。機械的な文字数切り分けは禁止。
 *
 * 政令指定都市優先: [^\d\s]+市[^\d\s]+区 パターンを最初に試みる。
 * 一般: 非貪欲で最初の市/区/町/村を市区町村境界とする。
 * 分割不能（境界文字なし・street部分が空）の場合は null を返す。
 */
function splitAddressCityStreet(
  address: string
): { city: string; street: string } | null {
  if (!address.trim()) return null;

  // 政令指定都市: 市+区 パターン（例: "名古屋市中区", "大阪市北区"）
  const complexMatch = address.match(/^([^\d\s]+市[^\d\s]+区)(.+)$/);
  if (complexMatch && complexMatch[2].trim()) {
    return { city: complexMatch[1], street: complexMatch[2] };
  }

  // 一般: 非貪欲で最初の 市|区|町|村 を境界とする
  const simpleMatch = address.match(/^(.+?[市区町村])(.+)$/);
  if (simpleMatch && simpleMatch[2].trim()) {
    return { city: simpleMatch[1], street: simpleMatch[2] };
  }

  return null;
}

// ============================================================================
// CSV行ビルダーユーティリティ
// ============================================================================

/** CSVフィールドをエスケープする（カンマ/改行/ダブルクォートを含む場合はクォート）。 */
function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes("\n") || value.includes('"')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/** CSVテキスト（ヘッダー+データ行）を Shift-JIS Buffer に変換する。 */
function buildCsvBuffer(header: string[], rows: string[][]): Buffer {
  const allLines = [header, ...rows].map((fields) =>
    fields.map(escapeCsvField).join(",")
  );
  const csvText = allLines.join("\r\n") + "\r\n";
  return iconv.encode(csvText, "Shift_JIS") as Buffer;
}

// ============================================================================
// 佐川 品名生成
// ============================================================================

/**
 * 佐川 col25 の品名を生成する（品名生成ルール準拠）。
 * 単品（U2内の商品が1種類1点のみ）: 商品名をそのまま出力。
 * 複数商品: 先頭U1の先頭アイテムのtitle + " 他"。
 * 仮置き上限（全角30文字）超過時は CsvGeneratorError をスロー。
 */
function buildSagawaProductName(
  orders: BaseOrder[],
  bundleGroupId: string
): string {
  const allItems = orders.flatMap((o) => o.order_items);
  const isSingle = allItems.length === 1 && allItems[0].amount === 1;

  let productName: string;
  if (isSingle) {
    productName = allItems[0].title;
  } else {
    const firstItem = orders[0].order_items[0];
    productName = firstItem ? `${firstItem.title} 他` : "（商品情報なし）";
  }

  const charCount = countZenkaku(productName);
  const LIMIT = 30;
  if (charCount > LIMIT) {
    throw new CsvGeneratorError(
      `佐川CSV（bundle_group_id: ${bundleGroupId}）の品名が仮上限を超えています` +
        `（${charCount}文字 / 仮上限${LIMIT}文字）。` +
        `品名短縮ルールまたはe飛伝IIIの正式上限を確認してください。`,
      bundleGroupId
    );
  }

  return productName;
}

// ============================================================================
// U2 展開（bundle_enabled=false 対応）
// ============================================================================

/**
 * U2の bundle_enabled に応じて CSV 生成単位に展開する。
 * bundle_enabled=true または注文が1件のみ: そのまま1単位。
 * bundle_enabled=false かつ複数注文: 注文ごとに1単位に展開。
 */
export function expandU2ToCsvUnits(
  bundleGroupId: string,
  bundleEnabled: boolean,
  orders: BaseOrder[]
): CsvInputUnit[] {
  if (bundleEnabled || orders.length <= 1) {
    return [{ bundleGroupId, orders }];
  }
  return orders.map((o) => ({ bundleGroupId, orders: [o] }));
}

// ============================================================================
// ヤマト/ネコポス CSV生成（B2クラウド・42列）
// ============================================================================

/** B2 CSV出荷予定日をAsia/Tokyo基準のYYYY/MM/DD形式で返す。 */
function getTodayJstForB2Csv(): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Failed to format JST date for B2 CSV");
  }
  return `${year}/${month}/${day}`;
}

/**
 * ヤマト宅急便またはネコポスのCSV行を生成する。
 * 対象: carrier === "yamato" または "nekopos"。
 *
 * @throws CsvGeneratorError バリデーションエラー時
 */
function buildYamatoRow(
  unit: CsvInputUnit,
  carrier: "nekopos" | "yamato"
): string[] {
  const { bundleGroupId, orders } = unit;

  // D案フォールバック（U2レベル判定）
  const source = getU2ReceiverSource(orders);
  if (source === null) {
    throw new CsvGeneratorError(
      `ヤマトCSV（bundle_group_id: ${bundleGroupId}）のお届け先情報が混在しています。` +
        `同梱グループ内の注文で、お届け先（order_receiver）の有無が混在しています。` +
        `配送業者変更またはセッション解除後に再確認してください。`,
      bundleGroupId
    );
  }

  checkU2RecipientConsistency(orders, source, bundleGroupId, "ヤマト/ネコポス");

  // 代表注文（先頭）から受け取り先情報を取得
  const rep = orders[0];
  const r = extractRecipient(rep, source);

  // 列12: 都道府県 + 住所
  // 文字数超過時もCSV出力を継続する（B2-ADDRESS-FORMAT-01 最小修正）
  // B2 Cloud側の取込エラー確認・修正運用に委ねる。切り捨て・自動分割は行わない。
  const col12 = `${r.prefecture}${r.addressStreet}`;

  // 列13: 建物名
  // 文字数超過時もCSV出力を継続する（B2-ADDRESS-FORMAT-01 最小修正）
  // B2 Cloud側の取込エラー確認・修正運用に委ねる。切り捨て・自動分割は行わない。
  const col13 = r.addressBuilding;

  // 列16: 氏名
  const col16 = r.fullName;

  // 42列の行を構築（E-1補正メモ: 38・39列目は空欄）
  const row = new Array<string>(42).fill("");
  // col1: お客様管理番号（佐川CSV col.10と同様。BUNDLE-01 B2準拠: orders[0]が代表）
  row[0] = orders[0].unique_key;
  // col2: 送り状種類 ネコポス="A" / 宅急便="0"
  row[1] = carrier === "nekopos" ? "A" : "0";
  // col5: 出荷予定日（Asia/Tokyo基準 YYYY/MM/DD）
  row[4] = getTodayJstForB2Csv();
  // col9: お届け先電話番号
  row[8] = r.tel;
  // col11: お届け先郵便番号
  row[10] = r.zip;
  // col12: 都道府県+住所
  row[11] = col12;
  // col13: 建物名
  row[12] = col13;
  // col16: 氏名
  row[15] = col16;
  // col18: 敬称
  row[17] = YAMATO_KEISHO;
  // col20: ご依頼主電話番号
  row[19] = YAMATO_SENDER_TEL;
  // col21: ご依頼主電話番号枝番 → 空欄
  // col22: ご依頼主郵便番号
  row[21] = YAMATO_SENDER_ZIP;
  // col23: ご依頼主住所
  row[22] = YAMATO_SENDER_ADDRESS;
  // col24: ご依頼主建物名アパートマンション
  row[23] = YAMATO_SENDER_BLDG;
  // col25: ご依頼主名
  row[24] = YAMATO_SENDER_NAME;
  // col26: ご依頼主名(ｶﾅ) → 空欄
  // col28: 品名（固定）
  row[27] = "WHATNOT HARDWEAR STORE ご購入商品";
  // col38: 発行枚数 → 空欄（E-1補正メモ）
  // col39: 個数口表示フラグ → 空欄（E-1補正メモ）
  // col40: ご請求先顧客コード（E-2補正メモ準拠：10桁ゼロ埋め）
  row[39] = YAMATO_BILLING_CODE;
  // col41: ご請求先分類コード（E-2補正メモ準拠：3桁ゼロ埋め）
  row[40] = YAMATO_BILLING_CLASS;
  // col42: 運賃管理番号（E-2補正メモ準拠：2桁ゼロ埋め）
  row[41] = YAMATO_FREIGHT_CODE;

  return row;
}

/**
 * ヤマト/ネコポス CSV Buffer を生成する。
 * 全 unit を処理し、1件でもエラーがあれば CsvGeneratorError をスロー。
 *
 * @throws CsvGeneratorError バリデーションエラー時
 */
export function generateYamatoNekoposCsv(
  units: CsvInputUnit[],
  carrier: "nekopos" | "yamato"
): Buffer {
  const rows = units.map((unit) => buildYamatoRow(unit, carrier));
  return buildCsvBuffer(YAMATO_HEADER, rows);
}

// ============================================================================
// 別送判定（佐川CSV用）
// ============================================================================

/** フィールド値を正規化する（null/undefined→空文字、trim、全角スペース→半角スペース）。 */
function normalizeField(value: string | null | undefined): string {
  if (value == null) return "";
  return value.trim().replace(/　/g, " ");
}

/**
 * purchaser と order_receiver を7フィールドで比較し、別送注文かどうかを判定する。
 * order_receiver が null の場合は false（通常注文）。
 * 1フィールドでも差分があれば true（別送注文）、全一致なら false（通常注文）。
 */
function isSeparateDeliveryForCsv(order: BaseOrder): boolean {
  const r = order.order_receiver;
  if (r === null) return false;
  return (
    normalizeField(order.last_name) !== normalizeField(r.last_name) ||
    normalizeField(order.first_name) !== normalizeField(r.first_name) ||
    normalizeField(order.zip_code) !== normalizeField(r.zip_code) ||
    normalizeField(order.prefecture) !== normalizeField(r.prefecture) ||
    normalizeField(order.address) !== normalizeField(r.address) ||
    normalizeField(order.address2) !== normalizeField(r.address2) ||
    normalizeField(order.tel) !== normalizeField(r.tel)
  );
}

// ============================================================================
// 佐川 CSV生成（e飛伝III・74列）
// ============================================================================

/**
 * 佐川 e飛伝III のCSV行を生成する。
 *
 * @throws CsvGeneratorError バリデーションエラー時
 */
function buildSagawaRow(unit: CsvInputUnit): string[] {
  const { bundleGroupId, orders } = unit;

  // D案フォールバック（U2レベル判定）
  const source = getU2ReceiverSource(orders);
  if (source === null) {
    throw new CsvGeneratorError(
      `佐川CSV（bundle_group_id: ${bundleGroupId}）のお届け先情報が混在しています。` +
        `同梱グループ内の注文で、お届け先（order_receiver）の有無が混在しています。` +
        `配送業者変更またはセッション解除後に再確認してください。`,
      bundleGroupId
    );
  }

  checkU2RecipientConsistency(orders, source, bundleGroupId, "佐川");

  const rep = orders[0];
  const r = extractRecipient(rep, source);

  // 住所分割（都道府県は r.prefecture で取得済み）
  const split = splitAddressCityStreet(r.addressStreet);
  if (!split) {
    throw new CsvGeneratorError(
      `佐川CSV（bundle_group_id: ${bundleGroupId}）の住所を市区町村/番地に分割できません。` +
        `住所: "${r.addressStreet}"。` +
        `市・区・町・村の境界文字が見つかりません。住所を確認してください。`,
      bundleGroupId
    );
  }

  // col6: 市区町村（文字数超過時もCSV出力を継続する）
  const col6 = split.city;

  // col7: 番地・建物名（addressStreet の番地部分 + address2, 文字数超過時もCSV出力を継続する）
  const col7 = `${split.street}${r.addressBuilding}`;

  // col8: 氏名（全角16文字上限、超過分を col9 へ）
  const fullName = r.fullName;
  let col8: string;
  let col9: string;
  if (countZenkaku(fullName) <= 16) {
    col8 = fullName;
    col9 = "";
  } else {
    // 全角16文字を超える場合: 16全角以内に収まる先頭部分を col8、残りを col9
    let cut = 0;
    let chars = 0;
    for (const ch of fullName) {
      const code = ch.codePointAt(0) ?? 0;
      const w =
        (code >= 0x0020 && code <= 0x007e) ||
        (code >= 0xff61 && code <= 0xff9f)
          ? 0.5
          : 1;
      if (chars + w > 16) break;
      chars += w;
      cut += ch.length;
    }
    col8 = fullName.slice(0, cut);
    col9 = fullName.slice(cut);

    if (countZenkaku(col9) > 16) {
      throw new CsvGeneratorError(
        `佐川CSV（bundle_group_id: ${bundleGroupId}）のお届け先氏名が32文字を超えています` +
          `（"${fullName}"、${countZenkaku(fullName)}文字）。` +
          `氏名を確認してください。`,
        bundleGroupId
      );
    }
  }

  // col25: 品名（品名生成ルール）
  const col25 = buildSagawaProductName(orders, bundleGroupId);

  // 74列の行を構築
  const row = new Array<string>(74).fill("");
  // col3: お届け先電話番号
  row[2] = r.tel;
  // col4: お届け先郵便番号
  row[3] = r.zip;
  // col5: 都道府県のみ
  row[4] = r.prefecture;
  // col6: 市区町村
  row[5] = col6;
  // col7: 番地・建物名
  row[6] = col7;
  // col8: 氏名（16全角以内）
  row[7] = col8;
  // col9: 氏名のオーバーフロー（超過なければ空欄）
  row[8] = col9;
  // col10: お客様管理番号（代表U1のunique_key。BUNDLE-01 B2準拠: order_unique_keysはソート済み、orders[0]が代表）
  row[9] = orders[0].unique_key;
  // col25: 品名
  row[24] = col25;
  // col42: 出荷個数（固定 "1"・E-1補正メモ）
  row[41] = "1";
  // col43: スピード指定（固定 "000"）
  row[42] = "000";
  // col44: クール便指定（固定 "001"）
  row[43] = "001";

  // col.18〜22: ご依頼主欄 — 別送注文（purchaser と order_receiver が異なる場合）のみ出力
  if (isSeparateDeliveryForCsv(rep)) {
    const purchaser = extractRecipient(rep, "purchaser");

    // 必須5項目欠損チェック（個人情報の具体値はメッセージに含めない）
    if (!purchaser.tel) {
      throw new CsvGeneratorError(
        `別送注文の注文主情報（tel）が取得できません（bundle_group_id: ${bundleGroupId}）`,
        bundleGroupId
      );
    }
    if (!purchaser.zip) {
      throw new CsvGeneratorError(
        `別送注文の注文主情報（zip_code）が取得できません（bundle_group_id: ${bundleGroupId}）`,
        bundleGroupId
      );
    }
    if (!purchaser.prefecture) {
      throw new CsvGeneratorError(
        `別送注文の注文主情報（prefecture）が取得できません（bundle_group_id: ${bundleGroupId}）`,
        bundleGroupId
      );
    }
    if (!purchaser.addressStreet) {
      throw new CsvGeneratorError(
        `別送注文の注文主情報（addressStreet）が取得できません（bundle_group_id: ${bundleGroupId}）`,
        bundleGroupId
      );
    }
    if (!purchaser.fullName) {
      throw new CsvGeneratorError(
        `別送注文の注文主情報（name）が取得できません（bundle_group_id: ${bundleGroupId}）`,
        bundleGroupId
      );
    }

    // col.18: ご依頼主電話番号
    row[17] = purchaser.tel;
    // col.19: ご依頼主郵便番号
    row[18] = purchaser.zip;
    // col.20: ご依頼主住所１（都道府県）
    row[19] = purchaser.prefecture;
    // col.21: ご依頼主住所２（addressStreet + addressBuilding。addressBuilding 空欄時は addressStreet のみ）
    row[20] = purchaser.addressBuilding
      ? `${purchaser.addressStreet}${purchaser.addressBuilding}`
      : purchaser.addressStreet;
    // col.22: ご依頼主名称１
    row[21] = purchaser.fullName;
  }

  return row;
}

/**
 * 佐川 e飛伝III CSV Buffer を生成する。
 * 全 unit を処理し、1件でもエラーがあれば CsvGeneratorError をスロー。
 *
 * @throws CsvGeneratorError バリデーションエラー時
 */
export function generateSagawaCsv(units: CsvInputUnit[]): Buffer {
  const rows = units.map((unit) => buildSagawaRow(unit));
  return buildCsvBuffer(SAGAWA_HEADER, rows);
}

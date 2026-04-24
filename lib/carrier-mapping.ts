// 配送方法カテゴリ判定・配送業者型定義（ORDER-01 準拠）
//
// 【責務の分離】
//   このファイルが扱う「カテゴリ（CarrierCategory）」と
//   DATA-01 U1 が扱う「配送業者（Carrier）」は別の概念。
//
//   CarrierCategory : BASEデータから推定した分類。このファイルで定義・判定する。
//   Carrier         : スタッフが最終確定してUpstashに保存する値。型定義のみここに置く。
//                     Upstashへの書き込みは Step 4 以降で実装する。

import type { BaseShippingLine } from "@/lib/base-api";

// ============================================================================
// 型定義
// ============================================================================

/**
 * ORDER-01 §2 のアプリ内カテゴリ（4分類）。
 * 配送方法名をこのカテゴリに変換してから出荷対象判定・表示制御を行う。
 * 配送方法名を直接 if 分岐に使うことは禁止（ORDER-01 §6）。
 */
export type CarrierCategory =
  | "delivery"      // 宅配系    ― 出荷対象・スタッフが佐川/ヤマトを選択
  | "nekopos"       // ネコポス系 ― 出荷対象・carrier は nekopos に確定
  | "non-delivery"  // 非配送    ― 出荷対象外・選択不可
  | "unknown";      // 不明      ― マッピング未登録。要スタッフ判断・選択不可

/**
 * DATA-01 U1 の carrier フィールド値（Upstash 保存前提）。
 * スタッフが最終確定する配送業者。CarrierCategory とは独立した値。
 *
 * null = スタッフ未選択（初期状態 / non-delivery / unknown には carrier が存在しない）
 */
export type Carrier = "sagawa" | "yamato" | "nekopos";

/**
 * マッピングテーブルの 1 エントリ。
 * 管理者が Upstash に登録・保守する（ORDER-01 §6 保守ルール）。
 * 'unknown' はマッピング未登録状態を意味するため、登録値には含まれない。
 */
export type ShippingMethodMappingEntry = {
  methodName: string;
  category: Exclude<CarrierCategory, "unknown">;
};

/**
 * classifyShippingMethod の返り値。
 *
 * 【フィールド説明】
 * category
 *   BASEデータから推定したカテゴリ。スタッフの最終選択（carrier）とは異なる。
 *
 * detectedMethodNames
 *   BASE API から取得した配送方法名の候補一覧（shipping_method → shipping_lines の順で収集）。
 *   isUnknown === true の場合: 管理者がマッピング登録時にここを参照して方法名を確認する。
 *   isUnknown === false の場合: マッチに使用した候補名。デバッグ・ログ用途。
 *
 * isUnknown
 *   true  = マッピング未登録の配送方法が検知された。UI アラート用フラグ（Step 6 以降で使用）。
 *   false = マッピングテーブルで正常に分類できた。
 *
 * suggestedCarrier
 *   カテゴリから導出した carrier の初期値候補。スタッフの最終選択ではない。
 *   nekopos カテゴリのみ一意に確定（"nekopos"）。
 *   delivery カテゴリは佐川/ヤマトをスタッフが選ぶため null。
 *   non-delivery / unknown は carrier 選択不可のため null。
 */
export type ClassificationResult = {
  category: CarrierCategory;
  detectedMethodNames: string[];
  isUnknown: boolean;
  suggestedCarrier: Carrier | null;
};

// ============================================================================
// デフォルトマッピングテーブル
//
// ORDER-01 §2 の例示をもとにした初期値。
// 本番運用では Upstash に保存された値がこれを上書きする（Step 4 以降）。
// ここに列挙されている配送方法名はあくまで初期値であり、
// コード分岐の根拠として使用してはならない（ORDER-01 §6 禁止事項）。
// ============================================================================

export const DEFAULT_SHIPPING_METHOD_MAPPING: ShippingMethodMappingEntry[] = [
  // 宅配系（例示。Upstash 登録値が優先）
  { methodName: "宅配便", category: "delivery" },
  { methodName: "送料無料", category: "delivery" },
  { methodName: "配送エリア制限商品（大型）", category: "delivery" },
  { methodName: "配送エリア制限商品（ガス等）", category: "delivery" },
  // ネコポス系（例示。Upstash 登録値が優先）
  { methodName: "ネコポス", category: "nekopos" },
  { methodName: "クロネコゆうパケット", category: "nekopos" },
  // 非配送（例示。Upstash 登録値が優先）
  { methodName: "配送対象外商品", category: "non-delivery" },
];

// ============================================================================
// 分類関数
// ============================================================================

/**
 * BASEの配送方法情報からアプリ内カテゴリを判定する。
 *
 * 【実機確認前の防御的設計】
 * BASE API が shipping_method（単一文字列）と shipping_lines（配列）の
 * どちらのパターンで配送方法名を返すか実機確認前のため未確定（実装参照文書 §10 確認項目5）。
 * 両フィールドから候補名を収集し、いずれかがマッピングに一致すればカテゴリを返す。
 * どちらのフィールドに決め打ちせず、将来の調整がしやすい構造にする。
 *
 * @param shippingMethod  BASE API の shipping_method フィールド値
 * @param shippingLines   BASE API の shipping_lines フィールド値（存在しない場合は空配列）
 * @param mapping         マッピングテーブル（通常は Upstash 取得値 + DEFAULT のマージ）
 */
export function classifyShippingMethod(
  shippingMethod: string,
  shippingLines: BaseShippingLine[],
  mapping: ShippingMethodMappingEntry[]
): ClassificationResult {
  // 両フィールドから配送方法名の候補を収集する（重複除去・空文字除去）
  const detectedMethodNames = extractMethodNames(shippingMethod, shippingLines);

  // マッピングテーブルを引いてカテゴリを決定する
  // 配送方法名を直接 if 分岐に使うことは禁止（ORDER-01 §6）。テーブル参照のみ許可。
  for (const name of detectedMethodNames) {
    const entry = mapping.find((m) => m.methodName === name);
    if (entry) {
      return {
        category: entry.category,
        detectedMethodNames,
        isUnknown: false,
        suggestedCarrier: inferCarrierFromCategory(entry.category),
      };
    }
  }

  // マッピング未登録 → 不明カテゴリ
  // detectedMethodNames に入っている名前を管理者がマッピング登録時に参照する
  return {
    category: "unknown",
    detectedMethodNames,
    isUnknown: true,
    suggestedCarrier: null,
  };
}

// ============================================================================
// 内部ヘルパー
// ============================================================================

/**
 * shipping_method と shipping_lines の両方から配送方法名を収集する。
 * 収集順序: shipping_method → shipping_lines[].method
 * 空文字・重複を除去して返す。
 */
function extractMethodNames(
  shippingMethod: string,
  shippingLines: BaseShippingLine[]
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  const candidates = [
    shippingMethod,
    ...shippingLines.map((l) => l.method),
  ];

  for (const name of candidates) {
    const trimmed = name?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      names.push(trimmed);
    }
  }

  return names;
}

/**
 * カテゴリから carrier の初期値候補を導出する。
 * スタッフの最終選択ではなく、UI の初期表示に使う参考値。
 *
 * nekopos  → "nekopos"（カテゴリから一意に確定）
 * delivery → null（佐川 / ヤマトはスタッフが選択する）
 * その他   → null（選択不可カテゴリ）
 */
function inferCarrierFromCategory(
  category: Exclude<CarrierCategory, "unknown">
): Carrier | null {
  if (category === "nekopos") return "nekopos";
  return null;
}

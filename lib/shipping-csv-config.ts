// B2 CSV用固定値（ネコポス・ヤマト宅急便共通）
// 佐川CSV用固定値・PDF帳票用設定値はここに含めない

// ご依頼主情報
export const YAMATO_SENDER_TEL = "0794-83-2088";
export const YAMATO_SENDER_ZIP = "673-0404";
export const YAMATO_SENDER_ADDRESS = "兵庫県三木市大村530";
export const YAMATO_SENDER_BLDG = "株式会社イトー";
export const YAMATO_SENDER_NAME = "WHATNOT HARDWEAR STORE";

// 請求先コード類（E-2補正メモ準拠：ゼロ埋め形式）
export const YAMATO_BILLING_CODE = "0794820301";  // 10桁ゼロ埋め
export const YAMATO_BILLING_CLASS = "001";         // 3桁ゼロ埋め
export const YAMATO_FREIGHT_CODE = "01";           // 2桁ゼロ埋め

// 敬称
export const YAMATO_KEISHO = "様";

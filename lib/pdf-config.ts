export const PDF_CONFIG = {
  issuer: {
    storeName: "WHATNOT HARDWEAR STORE",
    companyLabel: "運営会社：株式会社イトー",
    companyName: "株式会社イトー",
    address: "〒673-0404 兵庫県三木市大村530",
    phone: "TEL: 0794-83-2088",
    web: "Web: https://whatnot.jp",
    onlineShop: "OnlineShop（BASE）: https://whatnot.theshop.jp",
    email: "Mail: info@whatnot.jp",
    invoiceRegistrationNumber: "T5140001036660",
    logoPath: null,           // TODO: 将来の白黒PNG差し替え時にここを更新する
  },
} as const;

export const LOGO_SIZE_PT = 80;
export const LOGO_POSITION = "header" as const;
export const LOGO_MARGIN_BOTTOM = 8;

// PAYMENT_LABELS は許可リスト的に扱う。
// このマップに存在しない payment 値が来た場合、checkPaymentLabels で警告対象として検知される。
// 顧客向け PDF 表示はフォールバック（生コード）を維持する。
export const PAYMENT_LABELS: Record<string, string> = {
  creditcard: "クレジットカード決済", // 現在の想定値（BASE API復旧後に実値確認）
  paypay: "PayPay",  // 実値確認済み（2026-05-14 Step 4-D本番確認）
  paypal: "PayPal決済",
  bnpl: "PAY ID あと払い",
  // paypal / bnpl は BASE 公式の決済コードに基づき追加。
  // bnpl_installment は PAY ID 3回あと払いが有効化されるまで追加しない。
};

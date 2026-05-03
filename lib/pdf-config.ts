export const PDF_CONFIG = {
  issuer: {
    storeName: "WHATNOT HARDWEAR STORE",
    companyName: "株式会社イトー",
    address: "〒673-0404 兵庫県三木市大村530",
    phone: "0794-83-2088",   // PDF表示ラベル：TEL
    email: null,              // 非表示
    invoiceRegistrationNumber: "T5140001036660",
    logoPath: null,           // TODO: 将来の白黒PNG差し替え時にここを更新する
  },
} as const;

export const PAYMENT_LABELS: Record<string, string> = {
  creditcard: "クレジットカード決済", // 現在の想定値（BASE API復旧後に実値確認）
  // TODO: paypal / paypay 等はBASE API実値確認後に追記する
};

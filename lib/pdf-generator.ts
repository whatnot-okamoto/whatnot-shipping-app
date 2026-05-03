// PDF生成ロジック（納品書・領収書）
// pdf-lib + @pdf-lib/fontkit を使用
// フォント: public/fonts/NotoSansJP-Regular.otf / NotoSansJP-Bold.otf

import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "fs/promises";
import path from "path";
import type { BaseOrder } from "./base-api";
import type { U1Data } from "./order-store";
import { PDF_CONFIG, PAYMENT_LABELS } from "./pdf-config";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;
const RIGHT_EDGE = MARGIN + CONTENT_WIDTH;

const CARRIER_LABELS: Record<string, string> = {
  sagawa: "佐川急便",
  yamato: "ヤマト運輸",
  nekopos: "ネコポス",
};

// ============================================================================
// 型定義
// ============================================================================

type RecipientInfo = {
  lastName: string;
  firstName: string;
  zipCode: string;
  prefecture: string;
  address: string;
  address2: string;
};

export type PdfOrderInput = {
  order: BaseOrder;
  orderState: U1Data;
};

// ============================================================================
// エントリーポイント
// ============================================================================

/**
 * 納品書・領収書PDF一括生成。
 * 各注文につき納品書1ページ。receipt_required===true の注文は追加で領収書1ページ。
 * フォントはファイルシステムから読み込み。Google Fonts等は使用しない。
 */
export async function generateShippingDocumentsPdf(
  inputs: PdfOrderInput[]
): Promise<Uint8Array> {
  const regularFontPath = path.join(
    process.cwd(),
    "public/fonts/NotoSansJP-Regular.otf"
  );
  const boldFontPath = path.join(
    process.cwd(),
    "public/fonts/NotoSansJP-Bold.otf"
  );

  const [regularFontBytes, boldFontBytes] = await Promise.all([
    readFile(regularFontPath),
    readFile(boldFontPath),
  ]);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const regularFont = await pdfDoc.embedFont(regularFontBytes);
  const boldFont = await pdfDoc.embedFont(boldFontBytes);

  for (const { order, orderState } of inputs) {
    addDeliveryNotePage(pdfDoc, order, orderState, regularFont, boldFont);
    if (orderState.receipt_required === true) {
      addReceiptPage(pdfDoc, order, orderState, regularFont, boldFont);
    }
  }

  return pdfDoc.save();
}

// ============================================================================
// お届け先解決（DEST-01 PDF版）
//
// 成立条件: order_receiver が存在し、last_name+first_name が空でなく、
//           かつ address が空・null でない場合。
// zip_code は表示項目だが欠損しても不成立にはしない（PDF仕様）。
// フィールド単位の混在禁止（注文単位で判定）。
// ============================================================================

function resolveRecipient(order: BaseOrder): {
  destination: RecipientInfo;
  showBilling: boolean;
} {
  const r = order.order_receiver;
  const isValid =
    r !== null &&
    (r.last_name.trim() + r.first_name.trim()) !== "" &&
    r.address.trim() !== "";

  if (isValid && r) {
    return {
      destination: {
        lastName: r.last_name,
        firstName: r.first_name,
        zipCode: r.zip_code,
        prefecture: r.prefecture,
        address: r.address,
        address2: r.address2,
      },
      showBilling: true,
    };
  }

  return {
    destination: {
      lastName: order.last_name,
      firstName: order.first_name,
      zipCode: order.zip_code,
      prefecture: order.prefecture,
      address: order.address,
      address2: order.address2,
    },
    showBilling: false,
  };
}

// ============================================================================
// 住所整形ヘルパー
// ============================================================================

function formatAddress(info: RecipientInfo): string {
  return [info.prefecture, info.address, info.address2]
    .filter((v) => v && v.trim())
    .join("");
}

export function formatPurchaserAddress(order: BaseOrder): string {
  return [order.prefecture, order.address, order.address2]
    .filter((v) => v && v.trim())
    .join("");
}

// ============================================================================
// 描画ユーティリティ
// ============================================================================

function text(
  page: PDFPage,
  content: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number
): void {
  if (!content) return;
  page.drawText(content, { x, y, size, font, color: rgb(0, 0, 0) });
}

function textRight(
  page: PDFPage,
  content: string,
  rightX: number,
  y: number,
  font: PDFFont,
  size: number
): void {
  if (!content) return;
  const w = font.widthOfTextAtSize(content, size);
  page.drawText(content, { x: rightX - w, y, size, font, color: rgb(0, 0, 0) });
}

function hline(
  page: PDFPage,
  x: number,
  y: number,
  width: number,
  thickness = 0.5
): void {
  page.drawLine({
    start: { x, y },
    end: { x: x + width, y },
    thickness,
    color: rgb(0.6, 0.6, 0.6),
  });
}

function truncate(
  str: string,
  maxWidth: number,
  font: PDFFont,
  size: number
): string {
  if (font.widthOfTextAtSize(str, size) <= maxWidth) return str;
  let t = str;
  while (t.length > 0 && font.widthOfTextAtSize(t + "…", size) > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + "…";
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

// ============================================================================
// 納品書ページ
// ============================================================================

function addDeliveryNotePage(
  pdfDoc: PDFDocument,
  order: BaseOrder,
  orderState: U1Data,
  regularFont: PDFFont,
  boldFont: PDFFont
): void {
  const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
  const { destination, showBilling } = resolveRecipient(order);
  const issuer = PDF_CONFIG.issuer;

  // --- タイトル ---
  const titleText = "納　品　書";
  const titleSize = 18;
  const titleW = boldFont.widthOfTextAtSize(titleText, titleSize);
  text(page, titleText, (A4_WIDTH - titleW) / 2, 800, boldFont, titleSize);
  hline(page, MARGIN, 782, CONTENT_WIDTH, 1);

  // --- 二段組: お届け先（左）/ 発行者（右）---
  const midX = MARGIN + CONTENT_WIDTH * 0.5 + 10;
  const leftMaxW = midX - MARGIN - 12;
  const rightMaxW = RIGHT_EDGE - midX;

  let leftY = 768;
  let rightY = 768;

  // 左: お届け先
  text(page, "お届け先", MARGIN, leftY, boldFont, 8);
  leftY -= 14;

  if (destination.zipCode) {
    text(page, `〒${destination.zipCode}`, MARGIN, leftY, regularFont, 8);
    leftY -= 12;
  }
  const destAddr = formatAddress(destination);
  if (destAddr) {
    text(page, truncate(destAddr, leftMaxW, regularFont, 8), MARGIN, leftY, regularFont, 8);
    leftY -= 12;
  }
  text(
    page,
    `${destination.lastName}${destination.firstName}　様`,
    MARGIN,
    leftY,
    boldFont,
    10
  );
  leftY -= 18;

  if (showBilling) {
    text(page, "（請求先）", MARGIN, leftY, regularFont, 7);
    leftY -= 11;
    const billingAddr = formatPurchaserAddress(order);
    if (billingAddr) {
      text(
        page,
        truncate(billingAddr, leftMaxW, regularFont, 7),
        MARGIN,
        leftY,
        regularFont,
        7
      );
      leftY -= 10;
    }
    text(
      page,
      `${order.last_name}${order.first_name}`,
      MARGIN,
      leftY,
      regularFont,
      7
    );
    leftY -= 12;
  }

  // 右: 発行者情報
  text(
    page,
    truncate(issuer.storeName, rightMaxW, boldFont, 9),
    midX,
    rightY,
    boldFont,
    9
  );
  rightY -= 13;
  text(
    page,
    truncate(issuer.companyName, rightMaxW, regularFont, 8),
    midX,
    rightY,
    regularFont,
    8
  );
  rightY -= 12;
  text(
    page,
    truncate(issuer.address, rightMaxW, regularFont, 7),
    midX,
    rightY,
    regularFont,
    7
  );
  rightY -= 11;
  text(page, `TEL: ${issuer.phone}`, midX, rightY, regularFont, 7);
  rightY -= 11;
  text(
    page,
    `登録番号: ${issuer.invoiceRegistrationNumber}`,
    midX,
    rightY,
    regularFont,
    7
  );

  // 二段組の下端
  let y = Math.min(leftY, rightY) - 12;
  hline(page, MARGIN, y, CONTENT_WIDTH, 0.5);
  y -= 14;

  // --- 注文情報 ---
  text(page, `注文ID: ${order.unique_key}`, MARGIN, y, regularFont, 8);
  y -= 12;
  text(page, `注文日: ${formatDate(order.ordered)}`, MARGIN, y, regularFont, 8);
  y -= 12;
  const carrierLabel =
    CARRIER_LABELS[orderState.carrier] ?? (orderState.carrier || "未選択");
  text(page, `配送業者: ${carrierLabel}`, MARGIN, y, regularFont, 8);
  y -= 18;

  // --- 商品明細テーブル ---
  hline(page, MARGIN, y, CONTENT_WIDTH, 0.5);
  y -= 14;

  // 列設定（右端基準で配置）
  const col4R = RIGHT_EDGE;
  const col3R = RIGHT_EDGE - CONTENT_WIDTH * 0.19;
  const col2R = col3R - CONTENT_WIDTH * 0.14;
  const col1MaxW = col2R - MARGIN - 8;

  // ヘッダー行
  text(page, "商品名", MARGIN, y, boldFont, 7);
  textRight(page, "数量", col2R, y, boldFont, 7);
  textRight(page, "単価", col3R, y, boldFont, 7);
  textRight(page, "金額", col4R, y, boldFont, 7);
  y -= 12;
  hline(page, MARGIN, y, CONTENT_WIDTH, 0.3);
  y -= 10;

  // 明細行
  for (const item of order.order_items) {
    const rowTitle = item.variation
      ? `${item.title} (${item.variation})`
      : item.title;
    text(
      page,
      truncate(rowTitle, col1MaxW, regularFont, 7),
      MARGIN,
      y,
      regularFont,
      7
    );
    textRight(page, `${item.amount}`, col2R, y, regularFont, 7);
    textRight(page, formatYen(item.price), col3R, y, regularFont, 7);
    textRight(page, formatYen(item.price * item.amount), col4R, y, regularFont, 7);
    y -= 12;
  }

  y -= 4;
  hline(page, MARGIN, y, CONTENT_WIDTH, 0.3);
  y -= 12;

  // 送料（shipping_lines[0].shipping_fee を使用。複数の場合は先頭のみ）
  const shippingFee =
    order.shipping_lines.length >= 1 ? order.shipping_lines[0].shipping_fee : 0;
  textRight(page, "送料", col3R, y, regularFont, 8);
  textRight(page, formatYen(shippingFee), col4R, y, regularFont, 8);
  y -= 4;
  hline(page, col3R - 25, y, col4R - col3R + 25, 0.3);
  y -= 12;

  // 合計
  textRight(page, "合　計", col3R, y, boldFont, 9);
  textRight(page, formatYen(order.total), col4R, y, boldFont, 9);
}

// ============================================================================
// 領収書ページ
// ============================================================================

function addReceiptPage(
  pdfDoc: PDFDocument,
  order: BaseOrder,
  orderState: U1Data,
  regularFont: PDFFont,
  boldFont: PDFFont
): void {
  const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
  const issuer = PDF_CONFIG.issuer;

  // --- タイトル ---
  const titleText = "領　収　書";
  const titleSize = 18;
  const titleW = boldFont.widthOfTextAtSize(titleText, titleSize);
  text(page, titleText, (A4_WIDTH - titleW) / 2, 800, boldFont, titleSize);
  hline(page, MARGIN, 782, CONTENT_WIDTH, 1);

  let y = 762;

  // --- 宛名（空欄時は「　様」）---
  const recipientName = orderState.receipt_name
    ? `${orderState.receipt_name}　様`
    : "　　　様";
  text(page, recipientName, MARGIN, y, boldFont, 14);
  y -= 40;

  // --- 金額（大きく表示）---
  hline(page, MARGIN, y, CONTENT_WIDTH * 0.55, 0.5);
  y -= 16;
  text(page, formatYen(order.total), MARGIN, y, boldFont, 20);
  y -= 28;
  hline(page, MARGIN, y, CONTENT_WIDTH * 0.55, 0.5);
  y -= 20;

  // --- 但し書き（空欄時は「お品代として」）---
  const note = orderState.receipt_note || "お品代として";
  text(page, `但し書き：${note}`, MARGIN, y, regularFont, 10);
  y -= 16;

  // --- 決済方法（PAYMENT_LABELSでマッピング）---
  const paymentLabel = PAYMENT_LABELS[order.payment] ?? order.payment;
  text(page, `決済方法：${paymentLabel}`, MARGIN, y, regularFont, 10);
  y -= 16;

  // --- 発行日（PDF出力日）---
  const today = new Date().toISOString().slice(0, 10);
  text(page, `発行日：${today}`, MARGIN, y, regularFont, 10);
  y -= 30;

  // --- 発行者情報 ---
  hline(page, MARGIN, y, CONTENT_WIDTH, 0.8);
  y -= 16;

  text(page, issuer.storeName, MARGIN, y, boldFont, 11);
  y -= 16;
  text(page, issuer.companyName, MARGIN, y, regularFont, 10);
  y -= 14;
  text(page, issuer.address, MARGIN, y, regularFont, 9);
  y -= 13;
  text(page, `TEL: ${issuer.phone}`, MARGIN, y, regularFont, 9);
  y -= 13;
  text(
    page,
    `登録番号：${issuer.invoiceRegistrationNumber}`,
    MARGIN,
    y,
    regularFont,
    9
  );
}

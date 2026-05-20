// PDF生成ロジック（納品書・領収書）
// pdf-lib + @pdf-lib/fontkit を使用
// フォント: public/fonts/NotoSansJP-Regular.otf / NotoSansJP-Bold.otf

import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage, type PDFImage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "fs/promises";
import path from "path";
import type { BaseOrder, BaseOrderReceiver } from "./base-api";
import type { U1Data } from "./order-store";
import { PDF_CONFIG, PAYMENT_LABELS, LOGO_SIZE_PT } from "./pdf-config";

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
    "public/fonts/NotoSansJP-Regular.ttf"
  );
  const boldFontPath = path.join(
    process.cwd(),
    "public/fonts/NotoSansJP-Bold.ttf"
  );

  const [regularFontBytes, boldFontBytes] = await Promise.all([
    readFile(regularFontPath),
    readFile(boldFontPath),
  ]);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const regularFont = await pdfDoc.embedFont(regularFontBytes, { subset: false });
  const boldFont = await pdfDoc.embedFont(boldFontBytes, { subset: false });
  const helveticaFont = await pdfDoc.embedStandardFont(StandardFonts.Helvetica);

  let logoImage: PDFImage | null = null;
  try {
    const logoPath = path.join(process.cwd(), "public", "images", "logo.png");
    const logoBytes = await readFile(logoPath);
    logoImage = await pdfDoc.embedPng(logoBytes);
  } catch {
    console.warn("[PDF-LOGO-01] logo.png load failed. Fallback to no-logo PDF.");
  }

  for (const { order, orderState } of inputs) {
    addDeliveryNotePage(pdfDoc, order, orderState, regularFont, boldFont, helveticaFont, logoImage);
    if (orderState.receipt_required === true) {
      addReceiptPage(pdfDoc, order, orderState, regularFont, boldFont, helveticaFont, logoImage);
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

function normalizeField(val: string | null | undefined): string {
  return (val ?? "").trim().replace(/　/g, " ");
}

function resolveRecipient(order: BaseOrder): {
  destination: RecipientInfo;
  destinationSource: "receiver" | "purchaser";
  showBilling: boolean;
} {
  const r = order.order_receiver;
  const isValid =
    r !== null &&
    r !== undefined &&
    (r.last_name.trim() + r.first_name.trim()) !== "" &&
    r.address.trim() !== "";

  if (!isValid || !r) {
    return {
      destination: {
        lastName: order.last_name,
        firstName: order.first_name,
        zipCode: order.zip_code,
        prefecture: order.prefecture,
        address: order.address,
        address2: order.address2,
      },
      destinationSource: "purchaser",
      showBilling: false,
    };
  }

  // Step 2: purchaser と order_receiver の7フィールド同一性比較
  let allSame: boolean;
  try {
    const fields = ["last_name", "first_name", "zip_code", "prefecture", "address", "address2", "tel"];
    allSame = fields.every(
      (f) =>
        normalizeField(order[f as keyof BaseOrder] as string) ===
        normalizeField(r[f as keyof BaseOrderReceiver] as string)
    );
  } catch {
    allSame = false; // 比較失敗時は安全側として別送扱い
  }

  return {
    destination: {
      lastName: r.last_name,
      firstName: r.first_name,
      zipCode: r.zip_code,
      prefecture: r.prefecture,
      address: r.address,
      address2: r.address2,
    },
    destinationSource: "receiver",
    showBilling: !allSame,
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

function wrapText(
  str: string,
  maxWidth: number,
  font: PDFFont,
  fontSize: number
): string[] {
  if (!str) return [""];
  const lines: string[] = [];
  let currentLine = "";
  let currentWidth = 0;
  for (const char of str) {
    const charWidth = font.widthOfTextAtSize(char, fontSize);
    if (currentWidth + charWidth > maxWidth && currentLine.length > 0) {
      const lastSpace = currentLine.lastIndexOf(" ");
      if (lastSpace > 0 && lastSpace >= currentLine.length - 8) {
        lines.push(currentLine.slice(0, lastSpace));
        const remainder = currentLine.slice(lastSpace + 1) + char;
        currentLine = remainder;
        currentWidth = font.widthOfTextAtSize(remainder, fontSize);
      } else {
        lines.push(currentLine);
        currentLine = char;
        currentWidth = charWidth;
      }
    } else {
      currentLine += char;
      currentWidth += charWidth;
    }
  }
  if (currentLine.length > 0 || lines.length === 0) {
    lines.push(currentLine);
  }
  return lines;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

// ============================================================================
// 続きページ 簡略ヘッダー
// ============================================================================

function addContinuationHeader(
  page: PDFPage,
  order: BaseOrder,
  fonts: { regular: PDFFont; bold: PDFFont },
  y: number
): number {
  const col4R = RIGHT_EDGE;
  const col3R = RIGHT_EDGE - CONTENT_WIDTH * 0.19;
  const col2R = col3R - CONTENT_WIDTH * 0.14;
  const janColX = MARGIN;
  const titleColX = MARGIN + 58 + 4;

  text(page, "納品書（続き）", MARGIN, y, fonts.bold, 10);
  y -= 14;
  text(page, `注文ID: ${order.unique_key}`, MARGIN, y, fonts.regular, 8);
  y -= 14;
  hline(page, MARGIN, y, CONTENT_WIDTH, 0.5);
  y -= 14;
  text(page, "JAN", janColX, y, fonts.bold, 7);
  text(page, "商品名", titleColX, y, fonts.bold, 7);
  textRight(page, "数量", col2R, y, fonts.bold, 7);
  textRight(page, "単価", col3R, y, fonts.bold, 7);
  textRight(page, "金額", col4R, y, fonts.bold, 7);
  y -= 12;
  hline(page, MARGIN, y, CONTENT_WIDTH, 0.3);
  y -= 10;
  return y;
}

// ============================================================================
// 納品書ページ
// ============================================================================

function addDeliveryNotePage(
  pdfDoc: PDFDocument,
  order: BaseOrder,
  orderState: U1Data,
  regularFont: PDFFont,
  boldFont: PDFFont,
  helveticaFont: PDFFont,
  logoImage: PDFImage | null
): void {
  let page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
  const { destination, destinationSource, showBilling } = resolveRecipient(order);
  const destTel = destinationSource === "receiver"
    ? (order.order_receiver?.tel ?? "")
    : (order.tel ?? "");
  const issuer = PDF_CONFIG.issuer;

  const titleText = "納　品　書";
  const titleSize = 18;
  const logoGap = 40;

  // --- ヘッダー: ロゴ（左）＋タイトル＋注文情報（右肩）---
  let hlineY: number;

  if (logoImage) {
    const logoBottomY = A4_HEIGHT - 15 - LOGO_SIZE_PT;
    page.drawImage(logoImage, {
      x: MARGIN,
      y: logoBottomY,
      width: LOGO_SIZE_PT,
      height: LOGO_SIZE_PT,
    });
    const titleY = Math.round(logoBottomY + (LOGO_SIZE_PT - titleSize * 0.72) / 2);
    text(page, titleText, MARGIN + LOGO_SIZE_PT + logoGap, titleY, boldFont, titleSize);
    textRight(page, `注文ID: ${order.unique_key}`, RIGHT_EDGE, titleY, regularFont, 8);
    textRight(page, `注文日: ${formatDate(order.ordered)}`, RIGHT_EDGE, titleY - 13, regularFont, 8);
    hlineY = logoBottomY - 8;
  } else {
    const titleW = boldFont.widthOfTextAtSize(titleText, titleSize);
    text(page, titleText, (A4_WIDTH - titleW) / 2, 800, boldFont, titleSize);
    textRight(page, `注文ID: ${order.unique_key}`, RIGHT_EDGE, 800, regularFont, 8);
    textRight(page, `注文日: ${formatDate(order.ordered)}`, RIGHT_EDGE, 787, regularFont, 8);
    hlineY = 782;
  }

  hline(page, MARGIN, hlineY, CONTENT_WIDTH, 1);

  // --- 二段組: お届け先（左）/ 発行者（右）---
  const leftMaxW = CONTENT_WIDTH / 2 - 10;

  let leftY = hlineY - 22;
  let rightY = hlineY - 22;

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
    if (destTel) {
      text(page, `TEL: ${destTel}`, MARGIN, leftY, helveticaFont, 8);
      leftY -= 12;
    }
    if (!showBilling && order.mail_address) {
      text(page, `Mail: ${order.mail_address}`, MARGIN, leftY, helveticaFont, 8);
      leftY -= 12;
    }
    leftY -= 8;
  }
  text(
    page,
    `${destination.lastName} ${destination.firstName}　様`,
    MARGIN,
    leftY,
    boldFont,
    10
  );
  leftY -= 20;

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
    if (order.tel) {
      text(page, `TEL: ${order.tel}`, MARGIN, leftY, helveticaFont, 7);
      leftY -= 10;
    }
    if (order.mail_address) {
      text(page, `Mail: ${order.mail_address}`, MARGIN, leftY, helveticaFont, 7);
      leftY -= 10;
    }
    text(
      page,
      `${order.last_name} ${order.first_name} 様`,
      MARGIN,
      leftY,
      regularFont,
      7
    );
    leftY -= 12;
  } else {
    text(page, "（請求先）", MARGIN, leftY, regularFont, 7);
    leftY -= 11;
    text(page, "お届け先と同じ", MARGIN, leftY, regularFont, 7);
    leftY -= 11;
  }

  // 右: 発行者情報（左寄せ）
  const issuerOffset = boldFont.widthOfTextAtSize("WHATNOT", 9);
  const issuerX = MARGIN + CONTENT_WIDTH * 0.52 + issuerOffset;
  const rightMaxW = RIGHT_EDGE - issuerX;
  text(page, truncate(issuer.storeName, rightMaxW, boldFont, 9), issuerX, rightY, boldFont, 9);
  rightY -= 13;
  text(page, truncate(issuer.companyLabel, rightMaxW, regularFont, 8), issuerX, rightY, regularFont, 8);
  rightY -= 12;
  text(page, truncate(issuer.address, rightMaxW, regularFont, 7), issuerX, rightY, regularFont, 7);
  rightY -= 11;
  text(page, issuer.phone, issuerX, rightY, helveticaFont, 7);
  rightY -= 11;
  text(page, issuer.web, issuerX, rightY, regularFont, 7);
  rightY -= 11;
  text(page, issuer.onlineShop, issuerX, rightY, regularFont, 7);
  rightY -= 11;
  text(page, issuer.email, issuerX, rightY, helveticaFont, 7);
  rightY -= 11;
  text(page, `登録番号：${issuer.invoiceRegistrationNumber}`, issuerX, rightY, regularFont, 7);

  // 二段組の下端 → 商品明細テーブル区切り
  let y = Math.min(leftY, rightY) - 12;

  // --- 商品明細テーブル ---
  hline(page, MARGIN, y, CONTENT_WIDTH, 0.5);
  y -= 14;

  // 列設定（右端基準で配置）
  const col4R = RIGHT_EDGE;
  const col3R = RIGHT_EDGE - CONTENT_WIDTH * 0.19;
  const col2R = col3R - CONTENT_WIDTH * 0.14;
  const janColW = 58;           // 13桁JAN用（フォント7pt換算）
  const janColX = MARGIN;
  const titleColX = MARGIN + janColW + 4;
  const col1MaxW = col2R - titleColX - 28;

  // ヘッダー行
  text(page, "JAN", janColX, y, boldFont, 7);
  text(page, "商品名", titleColX, y, boldFont, 7);
  textRight(page, "数量", col2R, y, boldFont, 7);
  textRight(page, "単価", col3R, y, boldFont, 7);
  textRight(page, "金額", col4R, y, boldFont, 7);
  y -= 12;
  hline(page, MARGIN, y, CONTENT_WIDTH, 0.3);
  y -= 10;

  // 明細行（折り返し・改ページ対応）
  for (const item of order.order_items) {
    const wrappedLines = wrapText(item.title, col1MaxW, regularFont, 7);
    const contentHeight = wrappedLines.length * 12 + (item.variation ? 10 : 0);
    const rowHeight = contentHeight + 10;

    if (y - MARGIN < rowHeight) {
      page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
      y = A4_HEIGHT - MARGIN;
      y = addContinuationHeader(page, order, { regular: regularFont, bold: boldFont }, y);
    }

    const itemTopY = y;

    if (item.barcode) {
      text(page, item.barcode, janColX, itemTopY, regularFont, 7);
    }

    let drawY = itemTopY;
    for (const line of wrappedLines) {
      text(page, line, titleColX, drawY, regularFont, 7);
      drawY -= 12;
    }

    if (item.variation) {
      text(
        page,
        truncate(item.variation, col1MaxW, regularFont, 6),
        titleColX,
        drawY,
        regularFont,
        6
      );
      drawY -= 10;
    }

    textRight(page, `${item.amount}`, col2R, itemTopY, regularFont, 7);
    textRight(page, formatYen(item.price), col3R, itemTopY, regularFont, 7);
    textRight(page, formatYen(item.price * item.amount), col4R, itemTopY, regularFont, 7);

    hline(page, MARGIN, drawY, CONTENT_WIDTH, 0.3);

    y = itemTopY - rowHeight;
  }

  // 合計欄 収まり判定
  if (y - MARGIN < 62) {
    page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
    y = A4_HEIGHT - MARGIN;
    y = addContinuationHeader(page, order, { regular: regularFont, bold: boldFont }, y);
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

  // 合計金額
  textRight(page, "合計金額", col3R, y, boldFont, 9);
  textRight(page, formatYen(order.total), col4R, y, boldFont, 9);
  y -= 14;

  // 決済方法
  const paymentLabel = PAYMENT_LABELS[order.payment] ?? order.payment;
  text(page, `決済方法：${paymentLabel}`, MARGIN, y, regularFont, 8);
}

// ============================================================================
// 領収書ページ
// ============================================================================

function addReceiptPage(
  pdfDoc: PDFDocument,
  order: BaseOrder,
  orderState: U1Data,
  regularFont: PDFFont,
  boldFont: PDFFont,
  helveticaFont: PDFFont,
  logoImage: PDFImage | null
): void {
  const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
  const issuer = PDF_CONFIG.issuer;

  const titleText = "領　収　書";
  const titleSize = 18;
  const logoGap = 40;
  let hlineY: number;

  if (logoImage) {
    const logoBottomY = A4_HEIGHT - 15 - LOGO_SIZE_PT;
    page.drawImage(logoImage, {
      x: MARGIN,
      y: logoBottomY,
      width: LOGO_SIZE_PT,
      height: LOGO_SIZE_PT,
    });
    const titleY = Math.round(logoBottomY + (LOGO_SIZE_PT - titleSize * 0.72) / 2);
    text(page, titleText, MARGIN + LOGO_SIZE_PT + logoGap, titleY, boldFont, titleSize);
    hlineY = logoBottomY - 8;
  } else {
    const titleW = boldFont.widthOfTextAtSize(titleText, titleSize);
    text(page, titleText, (A4_WIDTH - titleW) / 2, 800, boldFont, titleSize);
    hlineY = 782;
  }

  hline(page, MARGIN, hlineY, CONTENT_WIDTH, 1);

  let y = hlineY - 20;

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
  text(page, issuer.companyLabel, MARGIN, y, regularFont, 10);
  y -= 14;
  text(page, issuer.address, MARGIN, y, regularFont, 9);
  y -= 13;
  text(page, issuer.phone, MARGIN, y, helveticaFont, 9);
  y -= 13;
  text(page, issuer.web, MARGIN, y, regularFont, 9);
  y -= 13;
  text(page, issuer.onlineShop, MARGIN, y, regularFont, 9);
  y -= 13;
  text(page, issuer.email, MARGIN, y, helveticaFont, 9);
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

import type { BaseOrder } from "./base-api";

export type PdfTaxAmountRow = {
  rate: 8 | 10;
  itemsSubtotal: number;
  includedTax: number;
};

export type PdfAmountSummary = {
  itemsSubtotal: number;
  shippingFee: number;
  codFee: number;
  total: number;
  hasReducedRateItem: boolean;
  taxRows: PdfTaxAmountRow[];
};

/**
 * PDFへ渡す確定済み注文の表示金額を一箇所で組み立てる。
 * 呼び出し前に prepareOrderForPdf() でキャンセル商品除外と金額経路検証を行う。
 */
export function buildPdfAmountSummary(order: BaseOrder): PdfAmountSummary {
  const [shippingLine] = order.shipping_lines;
  if (!shippingLine) {
    throw new Error("PDF amount summary requires one verified shipping line.");
  }
  const itemsSubtotal = order.order_items.reduce(
    (sum, item) => sum + item.price * item.amount,
    0
  );
  const subtotal8 = order.order_items
    .filter((item) => item.consumption_tax_rate === 8)
    .reduce((sum, item) => sum + item.price * item.amount, 0);
  const subtotal10 = order.order_items
    .filter((item) => item.consumption_tax_rate === 10)
    .reduce((sum, item) => sum + item.price * item.amount, 0);
  const taxRows: PdfTaxAmountRow[] = [];
  if (subtotal8 >= 1) {
    taxRows.push({
      rate: 8,
      itemsSubtotal: subtotal8,
      includedTax: Math.round((subtotal8 * 8) / 108),
    });
  }
  if (subtotal10 >= 1) {
    taxRows.push({
      rate: 10,
      itemsSubtotal: subtotal10,
      includedTax: Math.round((subtotal10 * 10) / 110),
    });
  }

  return {
    itemsSubtotal,
    shippingFee: shippingLine.shipping_fee,
    codFee: order.cod_fee ?? 0,
    total: order.total,
    hasReducedRateItem: order.order_items.some(
      (item) => item.consumption_tax_rate === 8
    ),
    taxRows,
  };
}

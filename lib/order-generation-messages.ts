import type { GenerationIssueCode } from "./pdf-order-assessment";

export const GENERATION_ISSUE_LABELS: Record<GenerationIssueCode, string> = {
  full_cancel: "全商品キャンセル済みのため、アプリの発行対象外です。",
  cancellation_state_unknown:
    "商品statusを確認できないため、アプリでキャンセル状態を確定できません。",
  amount_inconsistent:
    "BASEの商品金額項目が一致せず、アプリで正しい明細金額を確定できません。",
  unit_price_unknown:
    "アプリで商品単価を正確に確定できません。",
  shipping_data_unknown:
    "送料行がなく、アプリで配送情報を確定できません。",
  multiple_shipping_lines_unsupported:
    "複数送料行はC-5未確定のため、現在のアプリでは自動処理できません。",
  order_data_invalid:
    "PDF生成に必要なBASE注文データをアプリで読み取れません。",
  tax_rate_unknown:
    "商品の税率情報を確認できないため、アプリでPDFを生成できません。",
  not_in_open_orders:
    "BASE未対応一覧に存在しません。現在の注文状態を確認してください。",
};

export function buildBaseReviewGuidance(issues: GenerationIssueCode[]): string {
  if (issues.includes("full_cancel")) {
    return "BASEで全商品キャンセル済みであることを確認してください。出荷対象外のため、個別出荷は行いません。";
  }
  if (issues.includes("not_in_open_orders")) {
    return "出荷済み・キャンセルなどの可能性があります。BASEで各注文の現在状態を確認し、未発送かつ出荷対象の場合だけ既存手順で対応してください。";
  }
  return "注文自体が出荷できないという意味ではありません。BASEで現在の注文状態と該当項目を確認し、未発送かつ出荷対象の場合は既存手順で別途対応してください。";
}

# workflow_risk_gate.md

## 位置づけ

この文書は、BASE出荷アプリ開発でのGO境界、高リスク領域、停止条件を定義する。

詳細な設計資産や未確定論点はここへ詰め込まない。未確定判断は `followups.md`、作業入口の基本方針は `AGENTS.md` を参照する。

## GO境界

| GO種別 | 許可される範囲 | 含まないもの |
| --- | --- | --- |
| 提案GO | 方針、整理、草案提示 | ファイル作成、編集、テスト、commit、push |
| read-only GO | 指定範囲の読み取り、一覧取得、検索、状態確認 | 編集、テスト、commit、push、deploy、本番確認 |
| 編集GO | 指定されたファイルや範囲の編集 | テスト実行、commit、push、deploy、本番反映 |
| テスト・検証GO | 指定されたローカルテスト、lint、build、確認 | 外部接続、本番データ、秘密情報、commit、push |
| commit GO | 指定範囲のstageとcommit作成 | push、deploy、本番反映 |
| push GO | 指定リポジトリ、指定branchへのpush | deploy、本番反映、外部サービス更新 |
| deploy GO | 指定環境へのdeploy | 本番反映、本番設定変更、本番API操作 |
| 本番反映GO | 明示された本番反映作業 | 未指定の反映、追加の外部書き込み |
| 本番確認GO | 明示された本番確認作業 | 本番反映、設定変更、データ更新 |

編集GOはcommitを含まない。commit GOはpushを含まない。push GOはdeploy操作、本番反映確認、本番実機確認を含まない。deploy GOは本番反映を含まない。

ただし、旧CoWork記録上は、GitHub `master` pushがVercel Production自動deployに接続されていた可能性が高い。そのため、BASE出荷アプリ開発側の `master` へpushするGOでは、push自体がVercel自動deployを起動する可能性を事前に明示する。

production branchやVercel Git Integrationの現在状態が未確認の場合、push前に人間確認またはread-only確認を挟む。push後にVercel自動deployが走った可能性があっても、確認なしに本番反映済み・本番正常とは断定しない。

テスト・検証GOがあっても、外部サービス、本番データ、秘密情報、BASE API、配送CSV、帳票、請求・金額に触れる検証は別途明示GOと人間確認を必要とする。

## 高リスク領域

以下に触れる、または触れる可能性がある場合は、作業を止めて目的、対象範囲、読まない範囲、実行しない操作を明示する。

- `.env*`
- APIキー、トークン、secret、認証情報
- 実データ、注文実データ、顧客情報、個人情報
- 実CSV、実PDF帳票、実レスポンス
- BASE API、OAuth、NextAuth、Upstash
- PDF生成、CSV生成、帳票、配送、追跡番号
- 請求、金額、決済、支払いラベル
- debug / fixture
- 本番接続情報、本番確認、本番反映
- commit、push、deploy

## 停止条件

`.env*`、実CSV、実PDF帳票、実レスポンス、実データ疑い領域は、明示GOなしに読まない。

PDF / CSV / debug / fixture / docs本文へ、惰性で読み足さない。読む場合は、目的単位でGOを分け、現在実装事実として扱う範囲を明示する。

CoWork側設計資産、旧Claude文書、既存 `docs/` 本文は、現在実装事実そのものとして扱わない。必要な場合は、設計素材、legacy、再設計候補として分けて扱う。

未確認のUI導線、API接続、状態遷移を、未実装または不具合と断定しない。`followups.md` の未確定判断として扱う。

ChatGPT外部監査やSubagentレビューは、人間確認の代替ではない。高リスク領域では、一馬さんの明示確認を残す。

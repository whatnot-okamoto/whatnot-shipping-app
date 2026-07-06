# AGENTS.md

## 役割

このリポジトリは、BASE出荷アプリのアプリ本体repo / deploy対象repo候補である。

このリポジトリは、Codex開発の主文脈repoではない。

BASE出荷アプリのCodex開発における主文脈、運用ルール、残論点、設計判断、docs配置責任、アプリ本体repo操作導線は、`BASE出荷アプリCodex開発` repo側で扱う。

このリポジトリでは、アプリ実装コード、build / deploy に必要な設定、public assets、package / lockfile など、アプリ本体として必要なファイルを扱う。

## 作業前確認

作業前に、目的、GO種別、対象範囲、禁止範囲を確認する。

明示GOなしに、編集、テスト、commit、push、deploy、本番反映、本番確認を行わない。

`master` への push は、Vercel Production 自動deployを起動する可能性がある。push、deploy、本番確認は、それぞれ別GOとして扱う。

## 停止線

通常作業では、明示GOなしに次を読まない、出力しない、編集しない。

- `.env*`
- secret、token、APIキー、認証情報、環境変数値
- 実データ、実注文、顧客情報、個人情報
- 実CSV、実PDF、帳票、配送情報
- API実レスポンス
- 金額、請求、決済、支払い情報
- 本番接続情報、本番URL、本番確認結果

必要な場合は、目的、対象範囲、読んでよい情報、出力してはいけない情報、保存先を明示した別GOで扱う。

実値は、チャット、README、AGENTS、handoff、docs、要約メモなどのGit管理文書へ転記しない。

認証情報・環境変数の正式移行は、別トラックの `認証情報・環境変数移行設計GO` で扱う。

## docs の扱い

既存 `docs/` は、旧CoWork側から移動されてきた設計文書を含む可能性があるため、原典保全先候補として扱う。

明示GOなしに、`docs/` の削除、移動、コピー、要約置換、本文編集を行わない。

`docs/` の配置責任を整理する場合も、先に原典保全先、移動元、移動経緯、戻り道、Git履歴、バックアップ有無を確認する。

## 移行期の注意

このリポジトリには、過去のCodex移行作業中に作成された管理文書が残っている場合がある。

詳細な開発文脈、残論点、運用ルール、docs配置責任は、今後 `BASE出荷アプリCodex開発` repo側へ寄せる候補である。

アプリ本体repo側では、実装・build・deployに必要なファイルと、作業時の最小停止線を優先する。

過去の設計資産、旧Claude / CoWork由来文書、既存 `docs/`、現在の実装状態を混同せず、作業時点で確認できた事実だけを現在実装事実として扱う。

旧Claude / CoWork手順、旧投入文、旧agent設計、ChatGPT外部監査固定工程は、そのままCodex運用へ移植しない。必要に応じて参照、legacy、再設計候補として扱う。

ChatGPT外部監査は固定工程ではなく、必要時に使うレビュー手段の一つとして扱う。

## 技術スタック注意

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

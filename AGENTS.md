# AGENTS.md

## リポジトリの役割

このリポジトリは、BASE出荷アプリの実装正本である。

アプリコード、build・deployに必要な設定、public assets、package・lockfileを保持する。

設計、現在地、残論点、判断根拠、開発運用の正本は、次の新Primaryとする。

`C:\Users\okamotok1\Documents\CodexWork\BASE出荷アプリCodex開発本線`

旧Codex Primary `C:\Users\okamotok1\Documents\CodexWork\BASE出荷アプリCodex開発` は歴史資料であり、現役正本ではない。

App repoへ設計文書、詳細残論点、移管管理文書を再び蓄積しない。App repoには実装・build・deployに必要なファイルと最小限の停止線だけを置く。

## 作業開始時の確認

App作業開始時に、新Primaryの次を確認する。

1. `authority.md`
2. `workflow_risk_gate.md`
3. `session_state.md`
4. `followups/索引版.md`
5. 対象カテゴリの残論点
6. 必要な関連設計・判断根拠

新Primaryへアクセスできない場合、旧Codex Primaryへフォールバックせず、作業を停止して一馬さんへ報告する。

その後、Appの対象コードとGit状態を確認する。

## 開発ループ

同一のCodexタスクが、設計・現在地・残論点の確認、設計判断、App実装、ローカルテスト、自己レビュー、新Primaryの`session_state.md`と残論点の更新までを一貫して担当する。

目的、対象範囲、禁止範囲を先に示した一つの注意系GOで、次を連続して進められる。

- read-only確認
- 対象限定のローカル編集
- 対象限定のローカルテスト
- 差分とテスト結果の自己レビュー
- 新Primaryの状態更新
- 対象限定local commit

commit直前に対象ファイルとcommit構成を報告する。承認済み範囲内では、commitだけの追加承認待ちは設けない。

ChatGPTなどの固定外部監査を通常工程にしない。Loop Engineering、F-004、F-011、旧移管監督方式、旧Primaryの工程別GO細分化を導入しない。

## 個別承認が必要な操作

次は通常の注意系GOに含めず、個別の明示承認対象とする。

- push
- deploy、Vercel操作、Vercel READY確認
- 本番確認
- 依存関係導入、外部ネットワーク通信
- ファイル削除・移動
- Git履歴改変、reset、rebase、force push

`master`へのpushはVercel Productionの自動deployを起動する可能性があるため、push、deploy、本番確認を分離する。

## 情報の停止線

別の明示承認なしに、次の内容を読まない、出力しない。

- `.env*`
- 認証情報、secret、token、APIキー、環境変数値
- 個人情報、顧客情報
- 実注文、実取引データ
- 実CSV、実PDF
- API実レスポンス
- 本番接続情報、本番確認結果

必要な場合は、目的、対象範囲、読んでよい情報、出力・保存してはいけない情報を先に明示する。実値をチャットやGit管理文書へ転記しない。

## 技術スタック注意

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

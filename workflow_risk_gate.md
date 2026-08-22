# workflow_risk_gate.md

## 正本境界

このrepoは、BASE出荷アプリの実装正本である。

設計、現在地、残論点、判断根拠、詳細な承認境界の正本は、次の新Primaryとする。

`C:\Users\okamotok1\Documents\CodexWork\BASE出荷アプリCodex開発本線`

旧Primary `BASE出荷アプリCodex開発`は歴史資料であり、現役正本ではない。新Primaryへアクセスできない場合は旧Primaryへフォールバックせず、作業を停止する。

Appへ設計本文や詳細残論点を蓄積しない。

## 注意系：通常開発GO

対象範囲、目的、禁止範囲を先に示した一つの注意系GOで、同一Codexタスクが次を連続して実施できる。

- read-only確認
- 対象限定のローカル編集
- 対象限定のローカルテスト
- 差分とテスト結果の自己レビュー
- 新Primaryの状態更新
- 対象限定local commit

commit直前に対象ファイルとcommit構成を報告する。承認済み範囲内では、commitだけの追加承認待ちは設けない。

ChatGPTなどの固定外部監査を通常工程にしない。Loop Engineering、F-004、F-011、旧移管監督方式、旧Primaryの工程別GO細分化を導入しない。

## 個別の明示承認が必要な操作

次は通常の注意系GOへ含めない。

- push
- deploy、Vercel操作、Vercel READY確認
- 本番確認
- 依存関係導入、外部ネットワーク通信
- `.env*`、secret、token、APIキー、認証情報、個人情報、顧客情報、実注文、実取引データ、実CSV、実PDF、API実レスポンスへのアクセス
- ファイル削除・移動
- Git履歴改変、reset、rebase、force push

`master`へのpushはVercel Productionの自動deployを起動する可能性があるため、push、deploy、本番確認を分離する。

実値をチャットやGit管理文書へ転記しない。

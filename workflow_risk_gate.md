# workflow_risk_gate.md

この本体repoは、BASE出荷アプリのアプリ本体repo / deploy対象repo候補である。

Codex開発における詳細なGO境界、停止線、運用ルールの主な配置責任は、`BASE出荷アプリCodex開発` repo側の `workflow_risk_gate.md` へ移す方針である。

ただし、この本体repoを単独で開く可能性があるため、最低限の停止線をここにも残す。

明示GOなしに、次を行わない。

- 編集
- テスト・検証
- commit
- push
- deploy
- 本番反映
- 本番確認
- Vercel / GitHub設定確認または変更
- `.env*`、secret、token、APIキー、環境変数値、実データ、実CSV、実PDF、API実レスポンスの値の確認・転記・チャット展開

`master` へのpushは、Vercel Production自動deployを起動する可能性がある。push、deploy、本番確認は、それぞれ別GOとして扱う。

この文書のポインタ化は、過去履歴露出やpublic露出の解消を意味しない。
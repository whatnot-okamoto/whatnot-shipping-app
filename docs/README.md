# docs

この `docs/` は、旧Claude Code / CoWork体制およびCodex移行検討の過程で、本体repo側に残った設計文書、引き継ぎ文書、legacy文書を含む可能性がある。

現在のBASE出荷アプリCodex開発では、厚い設計素材、原典保全、引き継ぎ、legacy隔離、未決事項管理の主な配置責任は、`BASE出荷アプリCodex開発` repo側へ移す方針である。

この文書は、`docs/` を削除してよいという意味ではない。また、Git履歴上の露出やpublic repo上の露出が解消済みであることも意味しない。

この本体repo側 `docs/` を編集、削除、移動、要約置換、ポインタ化する場合は、先に以下を確認する。

- Codex開発repo側での原典保全先
- 移動元、移動経緯、戻り道
- Git履歴上の扱い
- public露出、履歴露出、private化要否
- push時のVercel Production自動deploy可能性

現在実装事実は、この `docs/` ではなく、本体repoのコード、設定、実行結果、明示GOで確認した事実を優先する。
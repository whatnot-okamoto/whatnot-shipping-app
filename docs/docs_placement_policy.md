# docs配置方針

## 1. 位置づけ

この文書は、BASE出荷アプリ開発における `docs/` 配置方針である。

既存 `docs/` 直下文書やCoWork側重要設計資産を、今後 `reference` / `handoff` / `operations` / `legacy` に分けるための方針を記録する。

この文書作成時点では、既存文書の移動、コピー、分類反映は行わない。

## 2. `docs/reference/` 方針

`docs/reference/` は、要件定義、概要設計、設計補強、設計判断などの設計原典を扱う候補である。

ここに置く文書は、現在実装事実そのものではなく、設計資産として扱う。現在実装事実は、作業時点でコード、設定、実行結果などから確認できた範囲に限定する。

ファイル名ベースの仮候補は以下である。

- `FLOW-01.md`
- `UI-01.md`
- `EXCEPTION-01.md`
- `RETURN-01.md`
- `TERM-01.md`
- `PICK-01-3.md`
- `CONFIRM-01.md`
- `WHATNOT出荷アプリ_設計書_DATA-01.md.md`
- `WHATNOT出荷アプリ_設計補強メモ_BUNDLE-01.md.md`
- `WHATNOT出荷アプリ_設計補強メモ_DEST-01.md.md`
- `WHATNOT出荷アプリ_設計補強メモ_ORDER-01.md.md`
- `WHATNOT出荷アプリ_設計補強メモ_PICK-01-2.md.md`
- `WHATNOT出荷アプリ_設計補強メモ_PICK-UI-01.md.md`
- `WHATNOT出荷アプリ_設計補強メモ_VERIFY-01.md.md`
- `設計補強メモ_棚卸し表.md.md`
- `E-1補正メモ.md`

上記は本文確認前の仮分類である。正式な移動や分類反映は、目的単位の本文確認GO後に判断する。

## 3. `docs/handoff/` 方針

`docs/handoff/` は、Codex引き継ぎ用の現在地要約、CoWorkからCodexへの変換メモ、参照順序を扱う候補である。

CoWork側 `session_state` は丸写ししない。Codex作業用に、現在地、完了済み、未確認、禁止範囲、次の一手へ要約・変換して扱う。

候補となる文書は以下である。

- `current_state.md`
- `cowork_to_codex_transition.md`
- `reference_order.md`

この文書作成時点では、上記ファイルは作成しない。

## 4. `docs/operations/` 方針

`docs/operations/` は、テスト運用、検証GO、権限移譲ルールから抽出する停止条件、運用注意を扱う候補である。

本番確認に近い注意点は扱ってよい。ただし、本番確認そのものの実行手順化、本番確認の実行、本番反映、deployには進まない。

候補となる内容は以下である。

- テスト運用の要約
- 検証GOの境界
- 権限移譲ルールから抽出する停止条件
- 本番確認に近い注意点
- 帳票、配送CSV、請求・金額、実データに触れる検証の停止条件

CoWork側のテスト運用手順や権限移譲ルールを扱う場合も、旧手順をそのまま採用せず、Codex側のGO境界と停止条件へ変換する。

## 5. `docs/legacy/` 方針

`docs/legacy/` は、Claude Code前提手順、旧agent、旧投入文、ChatGPT外部監査固定工程、古いpush / deploy / 本番確認手順を隔離する候補である。

legacyに置くものは、現在のCodex正本や現在実装事実として扱わない。

legacy候補は以下である。

- Claude Code前提の投入手順
- 旧agent設計
- 旧投入文
- ChatGPT外部監査を固定工程にする記述
- 古いpush / deploy / 本番確認手順
- root直下の `Step4-A3_実装指示文_最終確定版.md`
- root直下の `実装参照文書_ClaudeCode向け.md`
- `docs/Step4-AUTH_実装指示文_最終確定版.md`
- `docs/Step4-B_実装指示文_最終確定版.md`

この文書作成時点では、legacy候補の移動やコピーは行わない。

## 6. root直下文書の扱い

root直下の最小正本は以下である。

- `AGENTS.md`
- `workflow_risk_gate.md`
- `followups.md`

`AGENTS.md` は作業入口、`workflow_risk_gate.md` はGO境界と停止条件、`followups.md` は未確定判断の台帳として扱う。

`CLAUDE.md` は、現時点では互換ポインタとして残置する。編集や移動は行わない。

root直下の `Step4-A3_実装指示文_最終確定版.md`、`実装参照文書_ClaudeCode向け.md` は、後続でlegacy移動候補として扱う。ただし、このGOでは移動しない。

`package.json`、設定ファイル、`app/`、`lib/`、`scripts/` などのアプリ本体系は、docs配置整理の対象ではない。

## 7. 初回反映で行わないこと

この初回反映では、以下を行わない。

- `docs/reference/` のディレクトリ作成
- `docs/handoff/` のディレクトリ作成
- `docs/operations/` のディレクトリ作成
- `docs/legacy/` のディレクトリ作成
- 既存 `docs/` 直下文書の移動・分類
- CoWork資材コピー
- docs本文精読
- コード本文確認
- PDF / CSV / debug / fixture の確認
- `.env*`、実データ、実CSV、実PDF、実レスポンスの確認
- テスト実行
- push
- deploy
- 本番反映
- 本番確認

## 8. 次候補

次候補は以下である。いずれも目的単位でGOを分ける。

- 既存docs本文確認GO
- CoWork重要設計資産の原典保全GO
- legacy移動設計GO
- `docs/reference/` / `docs/handoff/` / `docs/operations/` / `docs/legacy/` のディレクトリ作成GO
- 既存root直下旧Claude文書の移動判断GO

この文書は、docs配置方針の初回固定であり、既存文書の移動やCoWork資材の移植を意味しない。

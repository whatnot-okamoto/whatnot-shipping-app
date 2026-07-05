# ファイル台帳（実ファイル名準拠版）

プロジェクト関連文書の管理台帳。Cowork 移行時に確認した既存移行文書に加え、Cowork 移行で新規作成・追加された文書も含む。
ファイル名は各ファイルの実ファイル名に準拠する。
配置場所は各カテゴリ・各行の記述を参照する（明記がない場合は `knowledge/_migrated/` 配下が既定）。

**2026-06-01 改訂**：CoWork 開発体制再定義セッションで方向 A（CoWork 設計役一本化・サブエージェント不採用・IMP-08 全廃棄）を採用。以下の変更を反映：
- `.claude/agents/architect.md` → `knowledge/design_role.md` へ移動・改訂（カテゴリ1 に追記）
- `test-operations-guide.md` を `knowledge/archive/` へ退避（カテゴリ6 の該当行を更新）
- 新カテゴリ8「退避済み運用設計（`knowledge/archive/` 配下）」を追加：auditor.md・audit_log.md・phase_b_design.md・test-operations-guide.md・agent_md_editing_safety.draft.20260527-01.md の5件

合計：61件（旧 56 件 + design_role.md・auditor.md・audit_log.md・phase_b_design.md・agent_md_editing_safety.draft の5件追加。test-operations-guide.md は移動のため重複しない）

**※ 退避元削除未実行・退避先と物理的に共存（2026-06-01 時点）**：本台帳のヘッダ・カテゴリ記述で使われる「移動」「退避」表現は、退避先（`knowledge/design_role.md` および `knowledge/archive/` 配下 5件）への**論理的な反映**を意味する。岡本さん判断により削除許可が拒否されているため、以下の退避元ファイル6件は物理的にはまだ存在しており、退避先と共存している。今後、退避元削除が実行された時点で本注記を解除する。

退避元（物理的に未削除のファイル）：
- `.claude/agents/architect.md`（退避先：`knowledge/design_role.md`）
- `.claude/agents/auditor.md`（退避先：`knowledge/archive/auditor.md`）
- `knowledge/audit_log.md`（退避先：`knowledge/archive/audit_log.md`）
- `knowledge/phase_b_design.md`（退避先：`knowledge/archive/phase_b_design.md`）
- `knowledge/test-operations-guide.md`（退避先：`knowledge/archive/test-operations-guide.md`）
- `.agent-drafts/agent_md_editing_safety.draft.20260527-01.md`（退避先：`knowledge/archive/agent_md_editing_safety.draft.20260527-01.md`）

---

## カテゴリ1：設計役の動き方を定める文書（7件）

| ファイル名 | 性質 | 参照タイミング |
|---|---|---|
| 設計役_起動OS_v0.2.md | 普遍固定 | チャット起動時・必須（旧チャット運用・現在は design_role.md に統合） |
| 設計役_自己点検ルール_v0.2.md | 普遍固定 | 起動OS読了直後（旧チャット運用・現在は design_role.md に統合） |
| 設計役_引継ぎ発火条件_v0.2.md | 普遍固定 | 引継ぎ判断時（旧チャット運用・現在は design_role.md に統合） |
| 設計役_世代交代チェックリスト_v0.2.md | 普遍固定 | 引継ぎ準備時（旧チャット運用・現在は design_role.md に統合） |
| 設計役_引継ぎ文テンプレート_v0.1.md | 普遍固定（型） | 引継ぎ文作成時（旧チャット運用・現在は design_role.md に統合） |
| **design_role.md（`knowledge/` 直下・2026-06-01 新設）** | 更新継続 | **対話開始時必須読み込み（設計役の現役挙動定義）。旧 `.claude/agents/architect.md` から移動・改訂** |
| WHATNOT出荷アプリ_実装フェーズ権限移譲ルール_v0.25.md（`knowledge/` 直下） | 更新継続 | Claude Code投入中の進行判断時 |

## カテゴリ2：設計正文（7件）

| ファイル名 | 性質 | 参照タイミング |
|---|---|---|
| WHATNOT_出荷アプリ_要件定義書_フェーズ1確定版_Rev4.md | 凍結 | 機能要件根拠確認時のみ |
| WHATNOT 出荷アプリ 概要設計書 フェーズ2 最終確定版 v3.md | 凍結・正文 | 実装の基本参照先 |
| WHATNOT 出荷アプリ 概要設計書 フェーズ2 中間スナップショット.md | 凍結・参照禁止 | 過去版・参照禁止 |
| WHATNOT出荷アプリ_設計書_DATA-01.md | 凍結 | 状態管理設計の参照 |
| FLOW-01.md | 凍結 | 業務フロー確認時 |
| UI-01.md | 凍結 | 画面設計確認時 |
| 実装参照文書_ClaudeCode向け.md | 更新継続 | Claude Code投入前・必須 |

## カテゴリ3-A：設計補強メモ・確定済み（16件）

| ファイル名 | 性質 | 参照タイミング |
|---|---|---|
| WHATNOT出荷アプリ_設計補強メモ_DEST-01.md | 凍結 | 送り先データソース設計参照時 |
| DEST-01-FIELD-01.md | 凍結 | DEST-01とセット参照 |
| WHATNOT出荷アプリ_設計補強メモ_BUNDLE-01.md | 凍結 | 同梱設計参照時 |
| BUNDLE-ID-01.md | 凍結 | BUNDLE-01とセット参照 |
| WHATNOT出荷アプリ_設計補強メモ_ORDER-01.md | 凍結 | 注文判定設計参照時 |
| ORDER-FIELD-01.md | 凍結 | BASE API識別子参照時 |
| ORDER-SNAPSHOT-01.md | 凍結 | スナップショット設計参照時 |
| WHATNOT出荷アプリ_設計補強メモ_PICK-01-2.md | 凍結 | ピッキング設計参照時 |
| WHATNOT出荷アプリ_設計補強メモ_PICK-UI-01.md | 凍結 | ピッキングUI設計参照時 |
| PICK-01-3.md | 凍結 | ピッキング未対応認知設計参照時 |
| WHATNOT出荷アプリ_設計補強メモ_VERIFY-01.md | 凍結 | チェックシート設計参照時 |
| RETURN-01.md | 凍結 | 棚戻し設計参照時 |
| TERM-01.md | 凍結 | 用語確認時 |
| CONFIRM-01.md | 凍結 | 確認UI設計参照時 |
| EXCEPTION-01.md | 凍結 | セッションロック中の例外操作時 |
| SAFEGUARD-01.md | 凍結 | 安全性評価参照時 |

## カテゴリ3-B：補正メモ（2件）

| ファイル名 | 性質 | 参照タイミング |
|---|---|---|
| E-1補正メモ.md | 凍結 | B2 CSV設計参照時・E-1とセット |
| E-2補正メモ.md | 凍結 | B2 CSV設計参照時・E-1補正とセット |

## カテゴリ4：実装指示文（4件）

| ファイル名 | 性質 | 参照タイミング |
|---|---|---|
| Step4-AUTH_実装指示文_最終確定版.md | 凍結・実装済み | 参照のみ |
| Step4-A3_実装指示文_最終確定版.md | 凍結・実装済み | 参照のみ |
| Step4-B_実装指示文_最終確定版.md | 凍結・実装済み | 参照のみ |
| Step4-C_実装指示文草案_Rev6_実装着手不可.md | 草案・投入禁止 | 設計参照のみ |

## カテゴリ5-A：残論点管理（7件）

場所：`knowledge/followups/` 配下
※ 移動時にファイル名から「残論点_」「残論点管理リスト_」のプレフィックスを除去している（ディレクトリで意味が伝わるため）

| ファイル名 | 性質 | 参照タイミング |
|---|---|---|
| 索引版.md | 更新継続 | 論点確認・追加・クローズ候補時 |
| PDF帳票系.md | 更新継続 | PDF帳票関連論点確認時 |
| データ_バックエンド系.md | 更新継続 | データ・バックエンド論点確認時 |
| UI系.md | 更新継続 | UI改善論点確認時 |
| 認証系.md | 更新継続 | 認証・OAuth論点確認時 |
| 実装条件_安全条件系.md | 更新継続 | ロック条件・フラグ論点確認時 |
| 完了アーカイブ.md | 追記専用 | 完了論点確認時 |

## カテゴリ5-B：設計確認済み記録（6件）

| ファイル名 | 性質 | 参照タイミング |
|---|---|---|
| BASE_API実レスポンス確認メモ_注文詳細フィールド構造_v0.1.md | 凍結 | BASE APIフィールド確認時 |
| 配送CSV構造比較メモ_マスク済み_v0.1.md | 凍結 | CSV列設計確認時 |
| PDF-AMOUNT-01_税率別集計ロジック設計案_v0.2.md | 凍結・中間版 | v0.3とセット参照 |
| PDF-AMOUNT-01_税率別集計ロジック設計案_v0.3最終版_修正版.md | 更新継続 | PDF金額設計参照時 |
| Step4D_本番確認_後続論点メモ_PDF領収書まわり_v0.1.md | 更新継続 | PDF領収書周辺論点確認時 |
| SAGAWA住所分割設計_過去チャット抽出結果_調査記録_v0.1.md（`knowledge/` 直下・2026-06-11 新設） | 調査記録・参照資料（更新継続の設計本文ではなく抽出結果の固定） | SAGAWA-CSV-ADDRESS-SPLIT-01 起票・恒久対応検討の根拠資料確認時 |

## カテゴリ6：工程管理（8件）

開発フェーズ進行・Cowork 移行・テスト運用・設計判断記録に関する工程管理文書。

| ファイル名 | 性質 | 参照タイミング |
|---|---|---|
| フェーズ3着手前チェックリスト_最終版.md | 凍結 | 参照のみ（着手済み） |
| 実運用デバッグ移行ロードマップ.md | 凍結 | 工程判断時 |
| 実運用デバッグ開始前チェックリスト.md | 凍結 | 工程判断時 |
| 設計補強メモ_棚卸し表.md | 凍結 | 補強メモ一覧確認時 |
| test-operations-guide.md（`knowledge/archive/` 配下へ退避：2026-06-01 方向 A 採用） | 退避済み | 歴史的経緯参照のみ（Phase A／B 区分撤回によりテスト前提失効。カテゴリ8 を参照） |
| initial-handoff.md（`_migrated_instructions/` 配下） | 凍結・橋渡し記録 | テスト B 実施時・移行経緯を遡る時 |
| original.md（`_migrated_instructions/` 配下） | 凍結・歴史的経緯保管 | 移行の経緯を遡る時・移植の漏れ・解釈差異を検証する時 |
| design-decisions.md（`knowledge/` 直下） | 更新継続（追記中心） | 新たな設計提案を行う前・過去判断の経緯を確認する時 |

## カテゴリ7：探索・候補文書（1件）

| ファイル名 | 性質 | 参照タイミング |
|---|---|---|
| UI改善探索まとめ_本線接続前.md | 未確定・本線未接続 | 監査・設計確認前に実装不可 |

## カテゴリ8：退避済み運用設計（`knowledge/archive/` 配下・2026-06-01 新設）（5件）

2026-06-01 CoWork 開発体制再定義セッションで方向 A（CoWork 設計役一本化・サブエージェント不採用・IMP-08 全廃棄）を採用したことに伴い退避された運用設計文書群。各ファイル冒頭に退避注記（退避日・退避理由・後継参照先・保全する学び）あり。

| ファイル名 | 性質 | 参照タイミング |
|---|---|---|
| auditor.md（`knowledge/archive/` 配下） | 退避済み | Cowork サブエージェント仕様再検討時のみ（旧 `.claude/agents/auditor.md`） |
| audit_log.md（`knowledge/archive/` 配下） | 退避済み | Phase B 並走検証の経緯参照時のみ（旧 `knowledge/audit_log.md`） |
| phase_b_design.md（`knowledge/archive/` 配下） | 退避済み | Phase B 設計合意の経緯参照時のみ（旧 `knowledge/phase_b_design.md`） |
| test-operations-guide.md（`knowledge/archive/` 配下） | 退避済み | Phase A 本運用テスト手順の経緯参照時のみ（旧 `knowledge/test-operations-guide.md`） |
| agent_md_editing_safety.draft.20260527-01.md（`knowledge/archive/` 配下） | 退避済み | IMP-08 経緯参照時のみ（旧 `.agent-drafts/agent_md_editing_safety.draft.20260527-01.md`） |

---

## 件数内訳

| カテゴリ | 件数 |
|---|---|
| カテゴリ1：設計役の動き方を定める文書 | 7 |
| カテゴリ2：設計正文 | 7 |
| カテゴリ3-A：設計補強メモ・確定済み | 16 |
| カテゴリ3-B：補正メモ | 2 |
| カテゴリ4：実装指示文 | 4 |
| カテゴリ5-A：残論点管理 | 7 |
| カテゴリ5-B：設計確認済み記録 | 6 |
| カテゴリ6：工程管理 | 8 |
| カテゴリ7：探索・候補文書 | 1 |
| カテゴリ8：退避済み運用設計（2026-06-01 新設） | 5 |
| **合計** | **63** |

**注**：カテゴリ6 の test-operations-guide.md はカテゴリ8 に退避済みのため、カテゴリ6・8 両方に1件ずつ記載されているが実体は1ファイル。実合計は **62件**（2026-06-11 SAGAWA住所分割設計_過去チャット抽出結果_調査記録_v0.1.md をカテゴリ5-B に新規追加）。

# Step 4-B 実装指示文（最終確定版）
## T5ロック発動 ＋ ロック後ステージ最小UI

作成：Step 4-B仕様確定後（ChatGPT監査 GO済み）
対象：Claude Code

---

## 0. 着手前に必ず読むこと

### 参照すべき設計文書（優先順）

1. この指示文（最初に読む）
2. `docs/実装参照文書_ClaudeCode向け.md`（技術スタック・全体方針）
3. DATA-01（状態管理の正文。U1〜U4・T5の定義）
4. FLOW-01（フェーズBステップ順序の正文）
5. CONFIRM-01（出荷準備開始ボタンの確認UI詳細）
6. BUNDLE-01・BUNDLE-ID-01（U2ロック単位の定義）
7. ORDER-FIELD-01（unique_key / U1識別子の確定仕様）
8. EXCEPTION-01（ロック中の例外操作制御）

### 絶対禁止事項

- U1〜U4のデータ構造を変更しないこと
- U3セッション構造（DATA-01定義）を変更しないこと
- `refetch_done_flag` / `diff_confirmed_flag` / `checklist_printed_flag` の意味・扱いを変更しないこと
- `orders:refetch_state` の削除タイミングをT5（session_statusをactiveにセット後）から変更しないこと
- Step 4-A3で実装済みのC2・C3・C4チェック（`POST /api/session/start` 冒頭）を削除・変更しないこと
- S1（PDF出力）以降の処理を実装しないこと
- `pdf_output_done_flag` / `checklist_printed_flag` の制御をこのStepで実装しないこと
- CSV出力・納品書PDF・チェックシート・出荷完了処理を実装しないこと
- `unique_key` とU1（注文単位）の対応を変更・再定義しないこと（後述1節）
- `app/api/orders/list/route.ts` の既存レスポンス構造を壊さないこと（後述2節）

---

## 1. unique_key とU1の関係（必須確認事項）

ORDER-FIELD-01の読み替えにより、現行実装ではBASE注文の一意識別子として `unique_key` を使用する。DATA-01上のU1＝注文単位という責務は維持し、実装キーとして `unique_key` を用いる。`unique_key` / `order_id` の対応を変更・再定義しない。

**本実装では以下を厳守すること：**

- Upstashキーは `order:{unique_key}` を使用する（DATA-01 ORDER-FIELD-01読み替え準拠）
- `carrier` / `hold_flag` などのロック可能条件の検証は、`order:{unique_key}` から対応するU1の注文状態を取得して行う
- コード内で `order_id` という変数名を使用する場合は、実値が `unique_key`（string）であることをコメントで明記する

---

## 2. `app/api/orders/list/route.ts` の変更方針

UI側のU2展開に `bundle_group_id` / `order_ids` / `carrier` / `hold_flag` が必要な場合、既存レスポンス構造を壊さずに**不足分だけ追加**すること。

- 既存画面（注文一覧表示・選択UI・Step 4-A3の再取得/差分確認表示）が参照しているフィールドは必ず維持する
- 追加フィールドは既存フィールドの末尾に追加する形とし、既存フィールドを削除・改名・型変更しないこと
- 追加後に既存の注文一覧・選択UI・Step 4-A3の動作に影響がないことを確認すること

---

## 3. 実装対象ファイル

### 変更（既存ファイル）

| ファイル | 変更内容 |
|---|---|
| `app/api/session/start/route.ts` | T5発動範囲の実装完成。ロック可能条件C1〜C6の追加・U2展開ロジック・U3作成 |
| `app/api/session/current/route.ts` | session_status: active時にlocked_bundle_group_ids・U2展開情報を返すよう拡張 |
| `app/api/orders/list/route.ts` | UI側U2展開に必要な情報（bundle_group_id / order_ids / carrier / hold_flag）が不足する場合のみ追加。既存構造を維持すること |
| `app/orders/page.tsx` | session_status: activeによる画面分岐・LockedStageView表示の切り替え・UI側U2展開ロジック |

### 新規作成

| ファイル | 内容 |
|---|---|
| `app/orders/components/SessionLockConfirmModal.tsx` | CONFIRM-01 #014 確認ダイアログ |
| `app/orders/components/LockedStageView.tsx` | ロック後ステージ最小UI（U2単位一覧） |
| `app/orders/components/LockedBundleGroupCard.tsx` | U2単位の表示カード |

---

## 4. U2展開ロジック（UI側・API側共通）

**UI側・API側の両方で、以下の展開手順を実行すること。**
ロック対象の判定基準は「スタッフが選択したU1集合」ではなく「U2展開後の全U1」である。

### 展開手順

```
① スタッフが選択した unique_key リストを受け取る
② 各 unique_key が属する bundle_group_id を
   bundle:{bundle_group_id} から取得する
③ bundle_group_id を重複排除して
   locked_bundle_group_ids 候補を作成する
④ locked_bundle_group_ids 候補の各U2の
   order_ids（全 unique_key）を展開する
   ← この展開後の全 unique_key が「ロック対象U1全件」
⑤ ロック対象U1全件に対して carrier / hold_flag を検証する
⑥ 検証通過後（API側のみ）T5を実行してU3を作成する
```

### 一部U1のみ選択された同梱群の扱い

スタッフが同梱群内の一部U1のみ選択していた場合、そのU2全体（配下の全U1）がロック対象になる。「スタッフが選択したU1集合」と「U2展開後のロック対象U1集合」に差分が生じる場合は、CONFIRM-01 #014の確認ダイアログで差分U1を「同梱のため追加」として明示すること。

---

## 5. API側のロック可能条件

`POST /api/session/start` でサーバーサイド検証する。**UIの非活性制御だけでは不十分。全条件をAPIサイドで必ず検証すること。**

Step 4-A3で実装済みのC2・C3・C4チェックは削除せず、本Stepで追加するC1・C5・C6と統合すること。

**C5・C6の検証対象は「U2展開後のロック対象U1全件」であること。選択U1のみを検証対象にしないこと。**

| # | 条件 | 判定対象・方法 | 不成立時レスポンス |
|---|---|---|---|
| C1 | 選択注文が1件以上存在すること | リクエストボディの `selected_unique_keys` の長さ | 400 |
| C2 | `refetch_done_flag === true` | `getRefetchState()` 参照（実装済み） | 409 |
| C3 | `diff_confirmed_flag === true` | `getRefetchState()` 参照（実装済み） | 409 |
| C4 | `has_new_uninitialized !== true` | `getRefetchState()` 参照（実装済み） | 409 |
| C5 | **U2展開後のロック対象U1全件**の `carrier` が確定済みであること | `order:{unique_key}.carrier` をUpstashで検証。空文字・未設定は不成立 | 400 |
| C6 | **U2展開後のロック対象U1全件**に `hold_flag === true` が含まれないこと | `order:{unique_key}.hold_flag` をUpstashで検証 | 400 |
| C7 | `picking_status === "completed"` | **一時除外（LOCK-CONDITION-01）。** 詳細は6節参照 | — |

---

## 6. LOCK-CONDITION-01 一時除外（必須明記事項）

**以下をコードの該当箇所に必ずコメントとして記載すること。**

```typescript
// LOCK-CONDITION-01: picking_status === "completed" は一時除外
// PICK系機能（ピッキングUI/API）が未実装のため、本条件をロック可能条件から除外している。
// PICK系機能の実装完了後に、全選択注文の picking_status === "completed" を
// ロック可能条件（C7）として必ず復帰させること。
// 残論点管理リスト: LOCK-CONDITION-01（後続保持・PICK系実装後に復帰必須）
```

スタッフ向けUIには「ピッキング条件は一時除外中」等の文言を一切表示しないこと。

---

## 7. CONFIRM-01 #014 確認UI

CONFIRM-01確定仕様に準拠する。

### 表示タイミング

ロック可能条件（C1〜C6）が全て充足された状態で、出荷準備開始ボタンを押下した時点。

### ダイアログの表示内容

| 表示項目 | 内容 |
|---|---|
| ロック対象件数 | 「X件の注文をロックします」（U2展開後のロック対象U1全件数） |
| ロック対象注文一覧 | U2展開後の全U1を列挙。各行に `unique_key`（注文ID）・`receiver_name`（注文者名）・`carrier`（配送業者）を表示 |
| 同梱による追加表示 | 選択U1集合とU2展開後ロック対象U1集合に差分がある場合、差分U1を「同梱のため追加」として明示する |
| 不可逆性提示 | 「ロック後の変更には緊急解除が必要です」を必ず表示する |

### 操作とロック発動タイミング

| 操作 | 動作 |
|---|---|
| 「出荷準備を開始する」ボタン押下 | T5を実行する。**このボタン押下完了時点がロック発動タイミング。ダイアログ表示中はロックしない** |
| 「戻る」ボタン押下 | ダイアログを閉じる。状態変更なし。ロック前ステージに戻る |

---

## 8. T5実行時のUpstashキー操作

### 参照のみ（変更しない）

| キー | 用途 |
|---|---|
| `orders:refetch_state` | refetch_done_flag・diff_confirmed_flagをU3へコピーするために参照 |
| `bundle:{bundle_group_id}` | locked_bundle_group_ids確定のために参照。U2自体は変更しない |
| `order:{unique_key}` | C5・C6検証のために参照。U1自体は変更しない |

### 作成

| キー | 内容 |
|---|---|
| `session:current` | session_id文字列を書き込む（ポインタキー） |
| `session:{session_id}` | U3本体。下表の初期値で作成する |

**U3初期値：**

| フィールド | 初期値 | 備考 |
|---|---|---|
| `session_id` | 新規生成 | |
| `session_status` | `"active"` | |
| `locked_bundle_group_ids` | 4節③の重複排除結果 | |
| `refetch_done_flag` | `orders:refetch_state` からコピー | |
| `diff_confirmed_flag` | `orders:refetch_state` からコピー | |
| `checklist_printed_flag` | `false` | |
| `emergency_unlock_log` | `[]` | |

### 削除

| キー | タイミング |
|---|---|
| `orders:refetch_state` | `session_status` を `"active"` にセットした**後**に削除する（DATA-01 T5準拠） |

### 変更しないもの

U1・U2・U4の各Upstashキーは、T5実行時に一切変更しない。

---

## 9. UI側のボタン活性/非活性条件

「出荷準備可能」ラベルは不採用。条件未充足の理由を表示して代替する。

**carrier・hold_flagの判定基準は「スタッフが選択したU1」ではなく「U2展開後のロック対象U1全件」であること。** UI側でも4節の展開手順を実行した上で判定すること。

| # | 条件 | 未充足時の表示文言 |
|---|---|---|
| U1 | 選択注文が1件以上あること | （選択なし状態のため文言不要） |
| U2 | `refetch_done_flag === true` | 「再取得が未完了です」 |
| U3 | `diff_confirmed_flag === true` | 「差分確認が未完了です」 |
| U4 | **U2展開後のロック対象U1全件**の `carrier` が選択済みであること | 「ロック対象に配送業者が未選択の注文があります」 |
| U5 | **U2展開後のロック対象U1全件**に `hold_flag === true` が含まれないこと | 「ロック対象に保留中の注文が含まれています」 |
| U6 | picking_status条件 | **一時除外。UIへの表示なし** |

未充足が複数ある場合は全て列挙して表示する。

---

## 10. ロック後ステージ最小UI

UI-01準拠。ロック後ステージはU2単位を主表示とする。

### LockedBundleGroupCard の表示項目

| 表示項目 | データソース | 備考 |
|---|---|---|
| bundle_group_id | U2 | 群の識別子 |
| 代表注文ID | `U2.representative_order_id`（実値は `unique_key`） | ORDER-FIELD-01準拠 |
| 配下注文IDリスト | `U2.order_ids`（実値は `unique_key` 配列） | ORDER-FIELD-01準拠 |
| 配送業者 | `U1.carrier`（配下U1全件が同一 `carrier` であること前提） | |
| 届け先概要 | `order_snapshot` 由来の `receiver_name` | 氏名のみ。住所は省略可 |
| 保留有無（不整合検知） | `U1.hold_flag`（配下U1のいずれかに `true`） | **原則として表示されない。** C6によりロック条件でhold_flag === trueのU1は除外済み。配下U1に `hold_flag === true` が存在する場合はデータ不整合として警告表示する |
| 領収書有無 | `U1.receipt_required`（配下U1のいずれかに `true`） | 領収書対象注文が含まれる場合に明示 |

### S1への導線

ロック後ステージの末尾に**説明文のみ**表示する。ボタン・非活性ボタン・プレースホルダーは一切設置しない。

> 「次のステップ：納品書・領収書PDF出力（Step 4-Cで実装）」

---

## 11. Step 4-Bで実装しないこと

以下は本Stepのスコープ外。実装しないこと。

| 項目 | 後続Step |
|---|---|
| S1：納品書・領収書PDF一括出力 | Step 4-C |
| S2：内容確認UI | Step 4-C |
| S3：CSV出力（佐川・ヤマト・ネコポス） | Step 4-D（S1完了後にのみ実行可能。FLOW-01 R0） |
| S4：送り状番号入力 | Step 4-D |
| S5：チェックシート出力・印刷 | Step 4-E |
| S6：目視照合 | アプリ側実装なし |
| S7：出荷完了処理（BASEステータス更新） | Step 4-F |
| pdf_output_done_flag の制御 | Step 4-C |
| checklist_printed_flag の制御（追加） | Step 4-E |
| 緊急セッション解除UI | 後続Step |
| ピッキング画面・フェーズA全般 | 別途スコープ |
| 検索・フィルタ・ソート | UI-SELECTION-01として後続保持 |

---

## 12. 完了条件

**実装しただけでは完了扱いにしないこと。本番URLで13節の本番確認項目を全て確認してから完了扱いとすること。**

| # | 完了条件 |
|---|---|
| 1 | ロック可能条件C1〜C6が全て充足された場合にのみ出荷準備開始ボタンが活性になること |
| 2 | carrier・hold_flagの判定がUI側・API側の両方で「U2展開後のロック対象U1全件」を基準に行われること |
| 3 | 条件未充足時にボタン非活性・未充足理由がUI上に表示されること（picking_status除外の文言はUI上に出さない） |
| 4 | CONFIRM-01 #014の確認ダイアログが表示され、ロック対象件数・注文一覧・差分・不可逆性提示が全て含まれること |
| 5 | 「出荷準備を開始する」押下完了時点でT5が実行されること。ダイアログ表示中はロックが発動しないこと |
| 6 | 「戻る」押下でダイアログが閉じ、状態変更がないこと |
| 7 | `POST /api/session/start` がC1〜C6未充足時に400/409を返すこと |
| 8 | U1選択 → U2展開 → `locked_bundle_group_ids` 確定の順序が正しく実行されること |
| 9 | T5実行後に `session:current` および `session:{session_id}` が正しく作成されること |
| 10 | T5実行後に `orders:refetch_state` がU3へコピーされ削除されること |
| 11 | `session_status: "active"` 検出時にロック後ステージ（LockedStageView）に切り替わること |
| 12 | LockedStageViewでU2単位の表示項目が正しく表示されること |
| 13 | `hold_flag === true` の配下U1が存在する場合に警告表示されること（不整合検知） |
| 14 | S1への説明文のみが表示され、ボタン類が設置されていないこと |
| 15 | LOCK-CONDITION-01の除外に関するコメントが該当箇所に明記されていること |
| 16 | `app/api/orders/list/route.ts` の既存フィールドが維持されていること |
| 17 | `npm run build` が通ること |
| 18 | Vercelデプロイが完了すること |

---

## 13. 本番確認項目

| # | 確認内容 | 期待する結果 |
|---|---|---|
| P1 | U2展開後のロック対象に配送業者未選択のU1がある状態でボタンを確認 | 非活性・「ロック対象に配送業者が未選択の注文があります」表示 |
| P2 | U2展開後のロック対象に保留中のU1がある状態でボタンを確認 | 非活性・「ロック対象に保留中の注文が含まれています」表示 |
| P3 | 再取得未完了の状態でボタンを確認 | 非活性・「再取得が未完了です」表示 |
| P4 | 差分確認未完了の状態でボタンを確認 | 非活性・「差分確認が未完了です」表示 |
| P5 | 全条件充足後にボタンを押下 | 確認ダイアログが表示される |
| P6 | ダイアログの「戻る」を押下 | ダイアログが閉じ、状態変更なし |
| P7 | 同梱群の一部U1のみ選択してダイアログを開く | 差分U1が「同梱のため追加」として表示される |
| P8 | ダイアログの「出荷準備を開始する」を押下 | T5が実行される |
| P9 | T5実行後のUpstash状態を確認 | `session:current`・`session:{session_id}` 作成済み、`orders:refetch_state` 削除済み |
| P10 | T5実行後の画面を確認 | LockedStageViewに切り替わる |
| P11 | LockedStageViewの表示を確認 | U2単位の表示項目が正しく表示される |
| P12 | S1導線の表示を確認 | 説明文のみ表示。ボタン類なし |
| P13 | carrier未確定のロック対象を含む状態で `POST /api/session/start` を直接リクエスト | 400が返る |
| P14 | `hold_flag === true` のロック対象を含む状態で `POST /api/session/start` を直接リクエスト | 400が返る |
| P15 | `refetch_done_flag` / `diff_confirmed_flag` 未完了状態で `POST /api/session/start` を直接リクエスト | 409が返る |

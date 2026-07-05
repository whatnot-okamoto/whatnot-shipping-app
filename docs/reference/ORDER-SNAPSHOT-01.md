# 設計補強メモ ORDER-SNAPSHOT-01
## BASE詳細由来のメイン画面表示用スナップショット保持方針

論点ID：ORDER-SNAPSHOT-01
タイトル：BASE詳細由来のメイン画面表示用スナップショット保持方針
ステータス：確定済み・再オープン禁止
作成日：2026-04-25
根拠：/api/orders/list 設計時のパフォーマンス問題（100件規模でN件BASE詳細取得が重い）

---

## 1. 位置づけ

本メモはDATA-01の補強レイヤーである。

DATA-01では「注文基本情報・商品明細・送料・配送方法・備考欄はBASE APIから都度取得する」とされている。
しかし、`/api/orders/list` がリクエストのたびにBASE詳細APIをN件叩くのは、Vercel無料枠の実行時間・API制限の観点から危険であることが判明した。

これに対応するため、BASE詳細由来の表示情報をUpstashにスナップショットとして保持する方針を設計補強として追加する。

**責務の分離：**

| データ | 保存先 | 役割 |
|---|---|---|
| アプリ内状態（carrier・hold_flag等） | U1（`order:{unique_key}`） | スタッフ操作由来の正データ |
| BASE表示用スナップショット | `order_snapshot:{unique_key}` | メイン画面表示に必要な最小限のBASE由来情報 |
| BASE詳細の正データ | BASE API | 正データはBASE側。Upstashは表示用キャッシュに過ぎない |

U1にBASE表示情報を混ぜすぎると、U1の責務（アプリ内状態管理）が曖昧になる。これを防ぐため、スナップショットを独立したキーとして分離する。

---

## 2. 保存キー

```
order_snapshot:{unique_key}
```

---

## 3. 保存対象（確定）

メイン画面表示・選択制御に必要な最小限のBASE由来情報のみを保存する。

```typescript
type OrderSnapshot = {
  unique_key: string;
  receiver_name: string;       // getReceiverName()で導出（DEST-01-FIELD-01準拠）
  order_date: string;          // YYYY-MM-DD（orderedをUnix秒から変換。ORDER-FIELD-01準拠）
  shipping_method_name: string; // shipping_lines[0].shipping_method（1件の場合のみ）
  shipping_fee: number;        // shipping_lines[0].shipping_fee（ORDER-FIELD-01準拠）
  shipping_lines_count: number; // shipping_linesの件数（C-5判定用）
  has_multiple_shipping_lines: boolean; // shipping_lines.length > 1
  shipping_category: "delivery" | "nekopos" | "non-delivery" | "unknown" | ""; // ORDER-01マッピング結果
  remark: string;              // 備考欄（BASE APIのremarkフィールド）。個人情報・住所補足等が含まれる可能性あり。ログ出力・テスト報告では値を伏せること。APIレスポンスはメイン画面表示用途に限定する
  item_count: number;          // order_items.length（商品種別数）
  items_summary: string;       // 商品名の簡易要約（例：「テストTシャツ M 他2点」）
};
```

**保存しないもの（過剰保持の禁止）：**

- 全商品明細の詳細（barcode・variation等）→ ピッキング情報はU4で管理
- 個人情報（tel・mail_address等）→ 表示不要
- BASE側で常に変わりうる全フィールド（payment・order_charge等）
- order_receiver の全フィールド（receiver_nameに集約済み）

---

## 4. 更新タイミング

### 4-1. 初回生成（/api/orders/init 実行時）

`/api/orders/init` でBASE詳細を取得する際に、あわせて `order_snapshot:{unique_key}` を生成する。

- `order_snapshot:{unique_key}` が存在しない場合のみ生成する（`nx: true`）
- 既存snapshotがある場合、`/api/orders/init` では上書きしない
- ただし、これはsnapshotを永久固定する意味ではない
- snapshotの更新は `POST /api/orders/refetch` によって行う（下記参照）

### 4-2. 更新（POST /api/orders/refetch 実行時）

再取得処理は以下の2段階とする。DATA-01の「差分確認前の正データ更新禁止」原則に準拠する。

**ステップ1（再取得直後）：**
- BASE詳細から新しいスナップショット候補を `order_snapshot_pending:{unique_key}` として一時保存する
- 正スナップショット（`order_snapshot:{unique_key}`）は変更しない
- 差分確認前に `order_snapshot:{unique_key}` を直接上書きしない

**ステップ2（差分確認完了後）：**
- スタッフが差分を確認・承認した後、`order_snapshot_pending` を `order_snapshot` に昇格させる
- `order_snapshot_pending` を削除する

**`order_snapshot_pending:{unique_key}` について：**

`order_snapshot_pending:{unique_key}` はORDER-SNAPSHOT-01で追加される再取得時一時キーであり、DATA-01の差分確認前正データ更新禁止の思想に接続する。差分確認完了前に `order_snapshot:{unique_key}` を直接上書きしないための補助キーである。DATA-01本文への直接追記は不要。本メモの補強レイヤーとして管理する。

### 4-3. 削除タイミング

出荷完了処理（DATA-01 T10）時に、U1・U2・U4と同時に削除する。

---

## 5. /api/orders/list の合成方針（確定）

`/api/orders/list` は以下5つのデータ源を合成して返す。BASE詳細APIは叩かない。

| データ源 | キー・取得方法 |
|---|---|
| BASE表示用スナップショット | `order_snapshot:{unique_key}` |
| U1（アプリ内状態） | `order:{unique_key}` |
| U2（同梱群情報） | `bundle:{bundle_group_id}` |
| U3（セッション状態） | `session:current` → `session:{session_id}` |
| U4集合評価（派生） | `index:picking:{unique_key}` → `picking:{order_item_id}` 群 |

---

## 6. GET /api/orders/list のレスポンス構造（確定）

U1（注文単位）を主とした `orders[]` を基本とする（UI-01準拠）。

```typescript
// GET /api/orders/list レスポンス

{
  session: {
    session_status: "none" | "active" | "unlocked" | "completed",
    locked_bundle_group_ids: string[],
    refetch_done_flag: boolean,
    diff_confirmed_flag: boolean
  },
  orders: [
    {
      // 識別子
      unique_key: string,

      // order_snapshot由来（BASE表示情報）
      receiver_name: string,
      order_date: string,
      shipping_method_name: string,
      shipping_fee: number,
      remark: string,
      item_count: number,
      items_summary: string,

      // 配送カテゴリ（ORDER-01マッピング結果）
      shipping_category: "delivery" | "nekopos" | "non-delivery" | "unknown" | "",

      // U1由来（アプリ内状態）
      carrier: string,
      hold_flag: boolean,
      hold_reason: string,
      receipt_required: boolean,
      app_memo: string,
      cancelled_flag: boolean,

      // U2由来（同梱群情報）
      bundle_group_id: string,
      bundle_order_unique_keys: string[],
      bundle_enabled: boolean,

      // U4集合評価（派生値・Upstashに保存しない）
      picking_status: "completed" | "in_progress" | "not_started",

      // 要確認フラグ
      needs_initialization: boolean,           // U1またはorder_snapshotが存在しない場合true
      has_multiple_shipping_lines: boolean,    // C-5未確認事項（shipping_lines複数件）
      has_unknown_shipping_method: boolean,    // マッピング未登録（unknownカテゴリ）

      // 選択可否（出荷準備開始対象として選択できるか）
      selectable_for_session: boolean,
      disabled_reason: string | null
    }
  ],
  meta: {
    total_order_count: number,
    uninitialized_count: number,
    unselectable_count: number
  }
}
```

---

## 7. ソート順

`orders[]` のデフォルトソート順は以下とする。

1. 要確認・選択不可の注文を先頭に表示
   - 未初期化（`needs_initialization: true`）
   - shipping_lines複数件（`has_multiple_shipping_lines: true`）
   - 配送方法unknown（`has_unknown_shipping_method: true`）
   - 保留中（`hold_flag: true`）
2. 注文日昇順（`order_date`）
3. `unique_key` 昇順

UIで後からフィルタ・並び替え可能にする余地を残す（実装はStep 3以降）。

---

## 8. 未初期化・C-5・unlockedセッションの扱い

### 未初期化注文

- `needs_initialization: true` として返す
- `selectable_for_session: false`
- `disabled_reason: "初期化が必要です（再取得を実行してください）"`
- `/api/orders/list` は自動initを行わない

### C-5未確認（shipping_lines複数件）

- `has_multiple_shipping_lines: true` として返す
- `selectable_for_session: false`
- `disabled_reason: "C-5未確認：配送方法が複数件あります（要確認）"`
- マッピング未登録（`has_unknown_shipping_method`）とは別フラグで管理

### session_status: unlocked

- 緊急解除済みとして表示する
- 自動的に `none` と同等には扱わない
- 再ロック可能かどうかは `refetch_done_flag` / `diff_confirmed_flag` / 選択注文状態を再確認してから判断する
- 必要に応じて再取得・差分確認・再選択を促す表示をする

---

## 9. 既存設計との接続

| 設計文書 | 接続内容 |
|---|---|
| DATA-01 | U1の責務をアプリ内状態に限定する原則を維持。スナップショットを別キーで分離することで準拠 |
| DATA-01（差分確認前の正データ更新禁止） | 再取得時は _pending キーを経由し、差分確認完了後に正スナップショットに昇格させる |
| ORDER-FIELD-01 | receiver_name取得・order_date変換・shipping_lines参照はORDER-FIELD-01に準拠 |
| DEST-01-FIELD-01 | receiver_name は getReceiverName() で導出 |
| BUNDLE-ID-01 | bundle_group_id は bg_ 形式で参照 |
| UI-01 | PCメイン画面はU1主データ単位。orders[]でU1主のレスポンスを実現 |
| TERM-01 #010 | POST /api/orders/refetch が「再取得」の定義に対応する |

---

## 10. 設計書への反映状態

未反映（補強レイヤーとして保持）。
DATA-01本文は変更しない。
本メモが実装時の正文として機能する。

監査GO後に「確定済み・再オープン禁止」とする。

---

## 11. items_summary 生成ルール（確定）

`items_summary` はメイン画面での商品概要表示に使用する。以下のルールで生成する。

- `order_items.length === 0` の場合：`"商品情報なし"`
- `order_items.length === 1` の場合：`order_items[0].title`
- `order_items.length >= 2` の場合：`order_items[0].title + " 他" + (order_items.length - 1) + "点"`

variation・数量・barcodeなどの詳細はsnapshotには保存しない。
必要になった場合は後続UI設計で拡張する。

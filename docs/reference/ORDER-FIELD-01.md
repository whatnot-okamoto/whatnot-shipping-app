# 設計補強メモ ORDER-FIELD-01
## BASE API実レスポンスに基づく識別子・フィールド名の確定

論点ID：ORDER-FIELD-01
タイトル：BASE API実レスポンスとDATA-01前提の差分確定・unique_key統一方針
ステータス：確定済み・再オープン禁止
作成日：2026-04-25
根拠：BASE API実機確認（GET /orders/detail/{unique_key} レスポンス実値より確定）

---

## 1. 位置づけ

本メモはDATA-01の補強レイヤーである。

BASE API詳細エンドポイントの実機確認により、DATA-01が前提としていた `order_id`（number）が
BASE APIに存在しないことが判明した。

注文の一意識別子は `unique_key`（string）のみである。

これに伴い、U1/U2/U4のキー設計・フィールド名・参照構造を `unique_key` 基準に統一する。

---

## 2. 判明した事実：order_id は存在しない

BASE APIの一覧エンドポイント（GET /orders）および詳細エンドポイント（GET /orders/detail/{unique_key}）
のいずれにも、`order_id`（number）は存在しない。

注文を一意に識別できるフィールドは `unique_key`（string）のみである。

---

## 3. Upstashキー設計の読み替え

DATA-01上のキー定義を以下の通り読み替える。

| DATA-01上のキー名 | 実装上のキー名 |
|---|---|
| `order:{order_id}` | `order:{unique_key}` |
| `index:picking:{order_id}` | `index:picking:{unique_key}` |

U2の `order_ids` フィールドが保持する値は `unique_key`（string）の配列とする。
フィールド名 `order_ids` の扱いについては第4章を参照すること。

U4の所属注文参照フィールド（DATA-01上の `order_id`）は、実装上は `order_unique_key`（string）とする。

---

## 4. 各データ単位の識別子定義（確定）

### U1（注文単位）

| 項目 | 定義 |
|---|---|
| Upstashキー | `order:{unique_key}` |
| unique_keyの型 | string |
| 補助識別子 | U1のJSONオブジェクト内に `unique_key` フィールドを保持する |

### U2（同梱群単位）

| 項目 | 定義 |
|---|---|
| Upstashキー | `bundle:{bundle_group_id}` （変更なし） |
| order_ids フィールド | unique_key（string）の配列 |
| representative_order_id | 代表注文のunique_key（string） |

**暫定互換名について：**

`order_ids` / `representative_order_id` という名称は、既存DATA-01および関連設計との接続維持のために残す暫定互換名である。
実値は `unique_key`（string）であり、数値の `order_id` は存在しない。
新規実装・型定義・関数名では、可能な限り `order_unique_keys` / `representative_order_unique_key` への移行を優先する。
旧名を残す場合は、コメントで「実値はunique_key（string）」と明記する。

### U4（ピッキング進捗単位）

| 項目 | 定義 |
|---|---|
| Upstashキー | `picking:{order_item_id}` （変更なし） |
| インデックスキー | `index:picking:{unique_key}` |
| 所属注文参照フィールド | `order_unique_key: string` |

---

## 5. BaseOrder型のフィールド差分（確定）

BASE API詳細エンドポイントの実レスポンスとDATA-01が前提とするBaseOrder型の差分を確定する。

| DATA-01 / BaseOrder型の前提 | 実際のAPIフィールド名 | 型 | 実装時の扱い |
|---|---|---|---|
| `order_id` | 存在しない | — | `unique_key`（string）をU1識別子として使用 |
| `ordered_at`（ISO文字列） | `ordered` | number（Unix秒） | 日付変換：`new Date(order.ordered * 1000).toISOString().slice(0, 10)` |
| `total_price` | `total` | number | 金額系参照はすべて `total` を使用 |
| `order_items[].quantity` | `order_items[].amount` | number | U4の `required_quantity` 元値 |
| `order_items[].item_title` | `order_items[].title` | string | 商品名表示の元値 |
| `shipping_method`（トップレベル） | 常に `null` | null | 使用禁止。`shipping_lines[].shipping_method` を参照 |
| `shipping_lines[].method` | `shipping_lines[].shipping_method` | string | ORDER-01カテゴリ判定の元値 |
| `shipping_lines[].fee` | `shipping_lines[].shipping_fee` | number | 送料・差分検知の元値（第6章参照） |
| `shipping_lines[].order_item_ids` | `shipping_lines[].order_item_ids` | string[] | U4照合時はstring型として扱う。numberへの暗黙変換禁止 |

**送料参照元の統一：**

送料・差分検知では、`shipping_lines[].shipping_fee` を正の参照元とする。
トップレベル `shipping_fee` が存在する場合でも、同一値であることを確認できるまでは混用しない。
送料参照元を複数持たせず、実装上は `shipping_lines[].shipping_fee` に統一する。

---

## 6. 配送方法判定の変更（確定）

ORDER-01の配送方法カテゴリ判定において、参照するフィールドを以下の通り確定する。

| 項目 | 変更前の前提 | 確定後 |
|---|---|---|
| 判定元フィールド | `shipping_method`（トップレベル） | `shipping_lines[].shipping_method` |
| トップレベル `shipping_method` の扱い | 配送方法文字列 | 常にnull。使用禁止 |

**shipping_lines 複数件時の扱い（C-5未確認事項）：**

`shipping_lines` が複数件ある場合の確定値選択ロジックは、C-5未確認事項として保持する。
実APIで `shipping_lines` が常に確定1件であることを確認できるまでは、複数件時に自動で1件を選んで配送方法判定しない。
複数件が検出された場合は、未登録または要確認として扱い、別途ORDER-01補強または実機確認結果に基づいて確定する。

---

## 7. /api/orders/init の修正方針（確定）

### 注文取得フロー

```
1. fetchOrderedOrders() で未対応注文の一覧を取得
2. 一覧から unique_key を抽出
3. 各 unique_key で GET /orders/detail/{unique_key} を呼び、詳細データを取得
4. 詳細レスポンスを以下の内部形式へ正規化：
   - unique_key → U1識別子
   - ordered（Unix秒）→ 日付文字列（YYYY-MM-DD）への変換はアプリ側で実施
   - amount → required_quantity
   - title → 商品名
   - shipping_lines[].shipping_method → 配送方法カテゴリ判定の入力
   - shipping_lines[].shipping_fee → 送料
   - shipping_lines[].order_item_ids → string[]のまま保持
5. 正規化後の詳細データをもとにU1/U2/U4を初期化
6. 既存U1/U2/U4は nx: true で保護し、スタッフ入力値・ピッキング進捗を上書きしない
7. redis.pipeline().exec() のエラーを確認し、エラーがある場合は完了扱いしない
```

### N+1について

一覧取得1回 + 注文数分の詳細取得（N回）が発生する。
現状の運用規模では成立可能性はあるが、BASE APIの応答速度・Vercel実行時間・API制限により、
タイムアウトや一部取得失敗のリスクは残る。
実装時は、詳細取得のエラー検知、未取得注文の明示、完了扱いしない制御を必須とする。
並列取得を行う場合も、無制限の `Promise.all` ではなく、並列数を制限したバッチ取得を検討する。

---

## 8. 禁止事項（確定・実装時適用）

以下を実装コードに適用すること。

- `order_id` と `unique_key` を混在させない
- コード上で変数名を `order_id` のままにして、実値に `unique_key`（string）を入れる実装を避ける
  - やむを得ず旧名を残す場合は、コメントで「実値はunique_key（string）」と明記する
- トップレベルの `shipping_method`（常にnull）を配送方法判定に使用しない
- `shipping_lines[].order_item_ids`（string[]）を number[] として扱わない
- 一覧APIのデータだけでU1/U2/U4を生成しない（詳細APIの取得が必須）
- 詳細APIレスポンスを正規化せずにそのままUpstashへ書き込まない
- `ordered_at` フィールドを参照しない（存在しない）。`ordered`（Unix秒）を使用する
- `total_price` フィールドを参照しない（存在しない）。`total` を使用する
- `quantity` フィールドを参照しない（存在しない）。`amount` を使用する
- 詳細取得でエラーが発生した注文を完了扱いにしない
- `shipping_lines` 複数件時に自動で1件を選んで配送方法判定しない（C-5確認まで）
- 送料参照元として `shipping_lines[].shipping_fee` 以外を混用しない

---

## 9. 既存設計との接続

| 設計文書 | 接続内容 |
|---|---|
| DATA-01 | U1識別子・Upstashキー名をunique_key基準に読み替え。U2のorder_ids・U4のorder_unique_keyを更新 |
| ORDER-01 | 配送方法カテゴリ判定の入力元をshipping_lines[].shipping_methodに変更。複数件時はC-5確認後に確定 |
| DEST-01-FIELD-01 | order_receiver フィールド構造は変更なし（本メモと独立） |
| BUNDLE-01 | 同梱判定キーに使用するreceiver情報の取得元は詳細APIに限定 |
| FLOW-01 | フローの実行順序・ステップ定義は変更なし |

---

## 10. 設計書への反映状態

未反映（補強レイヤーとして保持）。
DATA-01・ORDER-01・概要設計書の本文変更は行わない。
本メモが実装時の正文として機能する。

監査GO後に「確定済み・再オープン禁止」とする。

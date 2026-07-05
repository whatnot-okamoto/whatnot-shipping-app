# 設計補強メモ DEST-01-FIELD-01

論点ID：DEST-01-FIELD-01  
タイトル：order_receiver フィールドキー名の実機確認結果と読替え確定  
ステータス：確定済み・再オープン禁止  
作成日：2026-04-24  
根拠：BASE API実機確認（C-1）`GET /1/orders/detail/:unique_key` レスポンス実値より確定

---

## 1. 位置づけ

本メモはDEST-01の補強レイヤーである。  
新規仕様の追加ではなく、C-1実機確認結果に基づく **order_receiver フィールドキー名の読替え確定** を記録する。  
DEST-01本文の設計思想（receiverを業務ロジックの基本とする）は変更しない。

---

## 2. 確定内容：order_receiver フィールドキー名

### 実機確認で判明したキー名

| 項目 | 想定キー名（確認前） | 実際のキー名（確認済み） |
|---|---|---|
| 姓 | name（単一フィールド想定） | `last_name` |
| 名 | name（単一フィールド想定） | `first_name` |
| 郵便番号 | zip | `zip_code` |
| 住所 | address | `address`（変更なし） |

### 姓名フィールドの順序

| フィールド | 内容 | 確認実値の例 |
|---|---|---|
| `order_receiver.first_name` | 名（given name） | 忍 |
| `order_receiver.last_name` | 姓（family name） | 石崎 |

**フルネーム連結順：`last_name + first_name`（例：石崎忍）**  
`first_name` を先に連結すると名姓順（忍石崎）になるため禁止。

補足：`order`（注文者）の `first_name` / `last_name` も同一の命名規則に従うことを確認済み。

---

## 3. 実装への影響範囲

以下の実装箇所でキー名の読替えが必要。

### 3-1. lib/base-api.ts（型定義）

`BaseOrder` 型の `order_receiver` を以下のように定義すること：

```typescript
order_receiver: {
  last_name: string;   // 姓（family name）
  first_name: string;  // 名（given name）
  zip_code: string;    // 郵便番号
  address: string;     // 住所
  // ... その他フィールド
} | null;
```

フルネームを組み立てる変換処理：

```typescript
const fullName = `${receiver.last_name}${receiver.first_name}`;
// NG: `${receiver.first_name}${receiver.last_name}` → 名姓順になるため禁止
```

### 3-2. CSV出力（D1）

送り先氏名フィールドのマッピング：

| CSV項目 | マッピング元 |
|---|---|
| 送り先氏名 | `order_receiver.last_name + order_receiver.first_name` |
| 送り先郵便番号 | `order_receiver.zip_code` |
| 送り先住所 | `order_receiver.address` |

### 3-3. 最終確認チェックシート（D7）

チェックシートの「送り先氏名」欄：  
`order_receiver.last_name + order_receiver.first_name` で生成する。

### 3-4. 同梱フラグ判定（D2）

同梱判定の氏名照合キー：  
`order_receiver.last_name + order_receiver.first_name` の連結値で照合する。

### 3-5. 納品書（D4）

お届け先欄の氏名：  
`order_receiver.last_name + order_receiver.first_name` で表示する。

---

## 4. DEST-01本文との対応関係

| DEST-01の記述 | 本メモでの読替え |
|---|---|
| 「receiverの氏名」 | `order_receiver.last_name + order_receiver.first_name`（last_name先頭） |
| 「receiverの郵便番号」 | `order_receiver.zip_code` |
| 「receiverの住所」 | `order_receiver.address` |

DEST-01本文のD1〜D7の設計方針・禁止事項・フォールバックルールは変更しない。  
本メモはフィールドキー名レベルの読替えのみを確定する。

---

## 5. C-2〜C-4 実機確認結果（記録）

本確認と同時に実施したC-2〜C-4の結果を記録する。

| # | 確認項目 | 結果 | 設計への影響 |
|---|---|---|---|
| C-2 | `shipping_fee` フィールドの存在 | ✅ 存在確認・値 `0`（送料無料注文） | 差分検知（送料変更検知）の実装前提を満たす |
| C-3 | `order_items[].status` の内容 | ✅ 存在確認・値 `"ordered"`（全items） | キャンセル差分検知（T3）に使用可能 |
| C-4 | `order_items[].order_item_id` の取得可否 | ✅ 存在確認・型 `number`・安定取得可能 | DATA-01 U4の識別子として使用可能 |

---

## 6. 禁止事項

- `order_receiver.first_name` を姓として扱うことは禁止
- フルネームを `first_name + last_name` 順で連結することは禁止
- 郵便番号を `zip` または `zip_code` 以外のキーで参照することは禁止
- 本メモの確定内容をDEST-01本文の設計方針変更として解釈することは禁止

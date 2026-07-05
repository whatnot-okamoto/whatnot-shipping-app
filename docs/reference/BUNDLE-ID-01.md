# 設計補強メモ BUNDLE-ID-01
## U2識別子（bundle_group_id）の決定論的生成方針

論点ID：BUNDLE-ID-01
タイトル：bundle_group_id を crypto.randomUUID() から決定論的ハッシュIDに変更する
ステータス：確定済み・再オープン禁止
作成日：2026-04-25
根拠：/api/orders/init 実機テスト結果（bundle:* キーが蓄積する問題を確認）

---

## 1. 問題の確認

実機テストにより、以下が確認された。

- `/api/orders/init` を再実行するたびに `bundle_group_id` が新規UUIDで生成される
- 同じ注文グループに対して毎回別の `bundle_group_id` が発行される
- `nx: true` によるU2保護が機能しない（異なるキーが作られるため）
- 古い `bundle:*` キーが際限なく蓄積する（実機で500件の古いキーを確認）

---

## 2. 採用方針：決定論的ハッシュID生成

`bundle_group_id` を、同梱判定キーから決定論的に生成する。

同じ同梱判定キーからは、常に同じ `bundle_group_id` が生成されることを保証する。

### ID形式

```
bg_{sha256(normalized_bundle_key).slice(0, 32)}
```

例：`bg_a3f8c2d1e4b7f9a0c3d5e8f1b2a4c6d8`

UUIDへの変換は不要。`bg_` プレフィックスにより決定論的IDであることを識別可能にする。

---

## 3. 同梱判定キーの定義（確定）

以下の5フィールドを結合した文字列を同梱判定キーとする。

```
ordered_date + "::" + receiver_name + "::" + receiver_zip_code + "::" + receiver_prefecture + "::" + receiver_address
```

| フィールド | 参照元 | 備考 |
|---|---|---|
| ordered_date | `ordered`（Unix秒）をYYYY-MM-DDに変換 | ORDER-FIELD-01準拠 |
| receiver_name | `getReceiverName(order)` | DEST-01-FIELD-01準拠 |
| receiver_zip_code | `getReceiverZipCode(order)` | DEST-01-FIELD-01準拠 |
| receiver_prefecture | `getReceiverPrefecture(order)` | DEST-01-FIELD-01準拠 |
| receiver_address | `getReceiverAddress(order)` | address + address2。DEST-01-FIELD-01準拠 |

**注意：** 同梱判定キーに `unique_key` 群は含めない。後から注文が増えた場合にIDが変わることを防ぐため。

---

## 4. 正規化ルール（確定）

同梱判定キー生成時に以下の正規化を適用する。

- 各フィールドの前後空白を除去する（`String.trim()`）
- `null` / `undefined` は空文字として扱う
- `address` と `address2` は結合して `getReceiverAddress()` で取得する
- `ordered` はUnix秒から `new Date(order.ordered * 1000).toISOString().slice(0, 10)` でYYYY-MM-DDに変換する
- receiver情報はDEST-01-FIELD-01およびORDER-FIELD-01で確定した詳細API由来フィールドを使う
- purchaser情報（トップレベルの `first_name` / `last_name` 等）ではなく、`order_receiver` を優先する
- `order_receiver` がnullの場合はpurchaser情報でフォールバックする（DEST-01-FIELD-01準拠）

---

## 5. 実装イメージ

```typescript
import { createHash } from "crypto";

function generateBundleGroupId(order: BaseOrder): string {
  const date = new Date(order.ordered * 1000).toISOString().slice(0, 10);
  const name = (getReceiverName(order) ?? "").trim();
  const zip  = (getReceiverZipCode(order) ?? "").trim();
  const pref = (getReceiverPrefecture(order) ?? "").trim();
  const addr = (getReceiverAddress(order) ?? "").trim();

  const key = [date, name, zip, pref, addr].join("::");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `bg_${hash}`;
}
```

このIDは同梱判定キーが同じであれば常に同一の値になる。

---

## 6. U2のNX保護の再確認

決定論的IDに変更することで、以下が実現する。

- 同じ注文グループには常に同じ `bundle_group_id` が生成される
- `nx: true` によりU2の重複書き込みが正しく防止される
- init再実行時に既存U2が保護される
- 古いキーの蓄積が止まる

---

## 7. セッション開始後の再生成禁止（DATA-01 / BUNDLE-01との接続）

- セッション開始前のinit再実行では、同じ判定キーなら同じ `bundle_group_id` を再利用する
- セッション開始後は `bundle_group_id` を再生成しない
- U3（セッション単位）の `locked_bundle_group_ids` に入ったIDは、そのセッション中に変更しない
- ロック中に配送業者変更や保留設定があっても、U2のID自体は変えない

---

## 8. 古い bundle:* キーの扱い

現在、過去の `crypto.randomUUID()` 由来の古い `bundle:*` キーが約500件残っている。

**現時点では削除しない。**

新方式への移行後、以下を整理してから削除可否を判断する。

- 新方式で生成される `bundle_group_id`（`bg_` プレフィックス付き）
- 旧方式の古い `bundle:*` キー（UUIDv4形式）
- 現在有効なU1/U4から参照されているU2
- 削除候補になる古いU2

削除候補一覧を作成した後、ChatGPT監査へ戻して判断を受ける。
削除の実行はClaude Codeへの指示確認後に行う。

---

## 9. 既存設計との接続

| 設計文書 | 接続内容 |
|---|---|
| DATA-01 | U2のキー生成ルールの変更。bundle_group_idの一意性保証がUUID→ハッシュIDに変わる |
| BUNDLE-01 | 同梱判定キーの定義を本メモに準拠させる |
| ORDER-FIELD-01 | receiver情報のフィールド参照元（詳細API由来）を維持する |
| DEST-01-FIELD-01 | getReceiverName / getReceiverZipCode / getReceiverPrefecture / getReceiverAddress を使用 |
| EXCEPTION-01 | セッション開始後のbundle_group_id変更禁止を維持 |

---

## 10. 設計書への反映状態

未反映（補強レイヤーとして保持）。
DATA-01・BUNDLE-01の本文変更は行わない。
本メモが実装時の正文として機能する。

監査GO後に「確定済み・再オープン禁止」とする。

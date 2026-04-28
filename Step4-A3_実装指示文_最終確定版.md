# Step 4-A3 実装指示文（最終確定版）
## 再取得・差分確認フラグの最小実装

作成：Step 4-A3仕様確定後（監査GO済み）
対象：Claude Code

---

## 0. 着手前に必ず読むこと

### 参照すべき設計文書（優先順）

1. この指示文（最初に読む）
2. 概要設計書（フェーズ2 v3）
3. DATA-01（状態管理の正文）
4. ORDER-SNAPSHOT-01（order_snapshot_pending の設計思想）
5. FLOW-01（フェーズBステップ順序）

### 絶対禁止事項

- 差分確認完了前に `order_snapshot:{unique_key}` を直接上書きしないこと
- `order_snapshot:{unique_key}` の更新は `POST /api/orders/diff-confirm` でスタッフ確認完了後のみ行うこと
- `has_new_uninitialized === true` の場合、`POST /api/orders/diff-confirm` は `diff_confirmed_flag` を true にしてはいけないこと
- `has_new_uninitialized === true` の場合は 400 または 409 相当で「初期化が必要」と返すこと
- RETURN-01の本格棚戻しUI・スクロール完了強制・注文キャンセル時の詳細オペレーションは実装しないこと
- DATA-01 T1の原則：再取得時点でU1・U2・U4の正データを更新しないこと
- Upstashのキー走査（KEYS命令）は使用しないこと

---

## 1. 実装範囲

### 含める

| # | 内容 |
|---|---|
| 1 | `orders:refetch_state` キーの実装（lib/refetch-store.ts） |
| 2 | `order_snapshot_pending:{unique_key}` 系の読み書き・`index:order_snapshot_pending` Setの管理（lib/order-store.ts追記） |
| 3 | `POST /api/orders/refetch`（再取得・pending生成・差分判定） |
| 4 | `POST /api/orders/diff-confirm`（確認承認・pending昇格または削除・フラグ更新） |
| 5 | 差分確認UI（DiffConfirmModal.tsx）：差分なし・差分あり・未初期化注文あり の3パターン対応 |
| 6 | メイン画面への再取得ボタン追加（page.tsx） |
| 7 | SessionStatusBarのフラグ表示更新 |
| 8 | `lib/session-store.ts` へのT5接続処理追加（orders:refetch_state → U3コピー・削除） |
| 9 | `POST /api/session/start` へのサーバー側検証追加 |

### 含めない

- RETURN-01の本格的な棚戻し指示UI
- スクロール完了強制
- 商品明細差分ごとの詳細な棚戻し運用
- 注文キャンセル時の詳細オペレーション設計
- ORDER-SNAPSHOT-02（ordered_timestamp追加）
- UI-FILTER系

---

## 2. 実装順序（必ず守ること）

### Step 1：ストア層

#### lib/refetch-store.ts を新規作成する

`orders:refetch_state`（固定キー）の読み書き関数を実装する。

**型定義：**

```typescript
type RefetchState = {
  refetch_done_flag: boolean;
  diff_confirmed_flag: boolean;
  refetched_at: string | null;    // ISO 8601。resetRefetchState()時はnull
  has_new_uninitialized: boolean;
};
```

**実装する関数：**

```typescript
getRefetchState(): Promise<RefetchState | null>
setRefetchState(state: RefetchState): Promise<void>
resetRefetchState(): Promise<void>
// 両フラグfalse・has_new_uninitialized false・refetched_at nullで初期化

deleteRefetchState(): Promise<void>
// T5時に呼ぶ。U3へのコピー完了後に削除すること
```

---

#### lib/order-store.ts に追記する

`order_snapshot_pending:{unique_key}` の読み書きと、Setキー `index:order_snapshot_pending` の管理を追加する。

**Setキー `index:order_snapshot_pending` の役割：**

- pending生成時：`SADD index:order_snapshot_pending {unique_key}`
- pending削除時：`SREM index:order_snapshot_pending {unique_key}`
- pending全件取得：`SMEMBERS index:order_snapshot_pending`
- KEYS命令は使用しないこと

**追加する関数：**

```typescript
getOrderSnapshotPending(uniqueKey: string): Promise<OrderSnapshot | null>

setOrderSnapshotPending(uniqueKey: string, snapshot: OrderSnapshot): Promise<void>
// SETと同時にSADD index:order_snapshot_pending {uniqueKey}を実行する

deleteOrderSnapshotPending(uniqueKey: string): Promise<void>
// DELと同時にSREM index:order_snapshot_pending {uniqueKey}を実行する

getAllPendingUniqueKeys(): Promise<string[]>
// SMEMBERS index:order_snapshot_pendingを使用する

deleteAllOrderSnapshotPending(): Promise<void>
// getAllPendingUniqueKeys()で取得したunique_key全件のpendingを削除する
// 全削除後にindex:order_snapshot_pendingも削除または空にする
```

`OrderSnapshot` 型はORDER-SNAPSHOT-01の定義に準拠すること。

---

### Step 2：API層

#### POST /api/orders/refetch

**app/api/orders/refetch/route.ts を新規作成する**

**処理の順序：**

1. `resetRefetchState()` を呼び出し、`orders:refetch_state` を初期化する
2. `deleteAllOrderSnapshotPending()` で既存pendingを全削除する
3. BASE APIから注文一覧を取得し、アプリ側で以下3条件を必ず適用する。この3条件フィルタ後の一覧を「BASE現在未対応注文一覧」として扱う

   ```
   order.dispatch_status === "ordered"
   order.dispatched === null
   order.terminated === false
   ```

4. `index:orders` のunique_keyセットとBASE現在未対応注文一覧を照合し、以下を分類する
   - **既存注文かつsnapshotあり**：index:ordersにもBASE現在未対応にも存在し、`order_snapshot:{unique_key}` が存在する → pending生成・差分比較対象
   - **消えた注文**：index:ordersにあるがBASE現在未対応にない → `diff_type: "disappeared"` として記録。pending生成対象外。詳細取得しない
   - **新規注文**：BASE現在未対応にあるがindex:ordersにない → `has_new_uninitialized = true` に設定。pending生成対象外。詳細取得しない
   - **snapshot未存在注文**（`order_snapshot:{unique_key}` がない）：needs_initializationとして扱う。pending生成対象外。詳細取得しない

5. **既存注文かつsnapshotありの注文のみ** `fetchOrderDetail(unique_key)` を使って詳細を取得する。buildOrderSnapshot相当の処理で `order_snapshot_pending:{unique_key}` を生成する
6. 既存の `order_snapshot:{unique_key}` と pendingを比較してDiffItemを生成する（比較フィールドは後述）
7. `orders:refetch_state` を更新する（`refetch_done_flag = true`・`refetched_at` = 現在時刻ISO文字列・`has_new_uninitialized` を設定）
8. レスポンスを返す

**レスポンス構造：**

```typescript
{
  success: boolean;
  refetch_done_flag: boolean;   // 常にtrue（成功時）
  diff_confirmed_flag: boolean; // 常にfalse（確認前）
  diff_result: {
    has_diff: boolean;                // diff_summary.length > 0
    has_new_uninitialized: boolean;
    new_uninitialized_count: number;  // UI表示用（「X件」に使用）
    diff_summary: DiffItem[];
  };
}

type DiffItem = {
  unique_key: string;
  diff_type: "item_changed" | "cancelled" | "fee_changed" | "new_order" | "disappeared" | "other";
  description: string;
  severity: "info" | "warning" | "blocking";
};
```

**severity基準：**

| diff_type | severity | 備考 |
|---|---|---|
| fee_changed | info | 送料変更 |
| item_changed | warning | 棚戻しが必要になる可能性あり |
| cancelled | blocking | 詳細処理はStep 4-A3では行わない。判定が困難な場合はdisappearedまたはotherに寄せて構わない |
| new_order | warning | 未初期化で出荷漏れにつながる可能性あり |
| disappeared | info | 表示対象から既に外れているため軽微 |
| other | info | その他の軽微な変更 |

**差分判定の比較フィールド（`order_snapshot` vs `order_snapshot_pending`）：**

- `shipping_fee`（送料）
- `shipping_method_name`（配送方法名）
- `shipping_lines_count`（shipping_lines件数）
- `item_count`（商品種別数）
- `items_summary`（商品概要）

**【重要】差分検出ロジックは最小比較に留めること：**

比較対象は上記5フィールドのみ。以下は実装しないこと。

- 商品明細ごとの詳細なbefore/after表示
- 棚戻し数量計算
- キャンセル詳細処理
- 上記以外のフィールド比較の追加

---

#### POST /api/orders/diff-confirm

**app/api/orders/diff-confirm/route.ts を新規作成する**

**処理の順序：**

1. `getRefetchState()` を呼び出す
   - `refetch_done_flag !== true` の場合は 400 を返す
   - `has_new_uninitialized === true` の場合は 409 を返す。メッセージ：「未初期化注文があります。初期化を実行してから再取得してください」
2. `getAllPendingUniqueKeys()` で pending対象の全unique_keyを取得する
3. 各pendingについて以下を処理する
   - **差分ありpending**（`order_snapshot:{unique_key}` と内容が異なる）：`order_snapshot:{unique_key}` に昇格（上書き）後、`deleteOrderSnapshotPending(uniqueKey)` を呼ぶ
   - **差分なしpending**：`deleteOrderSnapshotPending(uniqueKey)` のみ。snapshotへの昇格なし。既存snapshotは変更しない
4. `orders:refetch_state` の `diff_confirmed_flag` を true に更新する
5. レスポンスを返す

**レスポンス構造：**

```typescript
{
  success: boolean;
  diff_confirmed_flag: boolean; // true
}
```

---

### Step 3：UI層

#### app/orders/components/DiffConfirmModal.tsx を新規作成する

`POST /api/orders/refetch` のレスポンスを受け取り表示するモーダル。3パターンに対応する。

**パターン1：差分なし（has_diff: false・has_new_uninitialized: false）**

```
再取得しました
差分はありません
[確認して出荷準備へ進む]
```

確認ボタン押下 → `POST /api/orders/diff-confirm` を呼び出す → モーダルを閉じる → `GET /api/orders/list` を再取得して画面を更新する

**パターン2：差分あり（has_diff: true・has_new_uninitialized: false）**

```
再取得しました
以下の差分があります

[DiffItemの一覧表示]
severity: blocking → 赤表示
severity: warning  → 黄表示
severity: info     → グレー表示

[内容を確認しました]
```

確認ボタン押下 → `POST /api/orders/diff-confirm` を呼び出す → モーダルを閉じる → `GET /api/orders/list` を再取得して画面を更新する

**パターン3：未初期化注文あり（has_new_uninitialized: true）**

```
再取得しました
新しい未対応注文が {new_uninitialized_count} 件あります
アプリへの取り込み（初期化）が必要です

[初期化を実行する]
```

- 「確認しました」ボタンは表示しない
- 「初期化を実行する」ボタン押下 → `POST /api/orders/init` を呼び出す → 完了後、自動で `POST /api/orders/refetch` を再実行してDiffConfirmModalを更新する
- 自動再実行が重いと判断する場合は「再取得をもう一度実行してください」と表示しても構わない。推奨は自動再実行

---

#### app/orders/page.tsx を変更する

再取得ボタンを追加する。

**表示条件（session_statusと接続）：**

| session_status | 再取得ボタン |
|---|---|
| none | 表示・活性 |
| active（ロック中） | 非表示 |
| unlocked（緊急解除後） | 表示・活性 |
| completed | 表示・活性（通常想定外だが表示する） |

**ボタン文言：** 「再取得する」

**押下後の挙動：**

1. ローディング表示
2. `POST /api/orders/refetch` を呼び出す
3. レスポンスを受け取り `DiffConfirmModal` を開く
4. モーダルで確認完了後、`GET /api/orders/list` を再取得して画面を更新する

---

#### app/orders/components/SessionStatusBar.tsx を変更する

`GET /api/orders/list` のレスポンスの `session` フィールドから `refetch_done_flag` / `diff_confirmed_flag` を読み取り表示する。

**表示文言：**

| 状態 | 表示 |
|---|---|
| refetch_done_flag=false | 再取得：未 |
| refetch_done_flag=true・diff_confirmed_flag=false | 再取得：済　差分確認：未 |
| 両フラグtrue | 再取得：済　差分確認：済 |
| session_status=active | ロック中（再取得ボタン非表示） |

---

#### GET /api/orders/list を変更する

`session` フィールドに `refetch_done_flag` / `diff_confirmed_flag` を反映する。参照先は以下の通り。

| session_status | 参照先 |
|---|---|
| active | U3（`session:{session_id}`）のフラグを返す |
| none / unlocked / completed | `getRefetchState()` を呼び出し、フラグを返す。`orders:refetch_state` が存在しない場合は両フラグfalseとして返す |

---

### Step 4：T5接続処理とサーバー側検証

#### lib/session-store.ts に追記する

T5（セッション開始）処理に以下を追加する。

**サーバー側検証（POST /api/session/start 冒頭に追加）：**

`getRefetchState()` を呼び出し、以下をすべて満たさない場合はセッション開始を拒否する。

```
refetch_done_flag === true
diff_confirmed_flag === true
has_new_uninitialized !== true
```

満たさない場合は 400 または 409 で返す。
UIのボタン非活性だけでは不十分であり、API側でも必ず検証すること。

**T5実行時の orders:refetch_state → U3 引き継ぎ：**

1. `getRefetchState()` を呼び出す
2. `refetch_done_flag` / `diff_confirmed_flag` をU3（`session:{session_id}`）へコピーする
3. session_statusをactiveにする（既存のT5処理順序を維持）
4. `deleteRefetchState()` を呼び出し `orders:refetch_state` を削除する（session_statusをactiveにした後）

T5の既存処理順序（`locked_bundle_group_ids` 確定 → `session_status` を active に設定）は変更しないこと。

---

## 3. 出荷準備開始ボタンの活性条件（Step 4-B向け先行整理）

Step 4-Bの実装時に、以下の条件を出荷準備開始ボタンの活性判定に組み込むこと。Step 4-A3では実装しない。

```
orders:refetch_state.has_new_uninitialized !== true
```

また、`POST /api/session/start` にStep 4-A3で追加したサーバー側検証が、Step 4-Bの安全条件を兼ねる。

---

## 4. 完了条件

以下をすべて満たすこと。

| # | 条件 |
|---|---|
| 1 | `orders:refetch_state` キーにフラグが正しく保存・参照される |
| 2 | `index:order_snapshot_pending` SetキーによりKEYS命令なしでpending全件取得・削除ができる |
| 3 | `POST /api/orders/refetch` でBASE一覧取得後にアプリ側3条件フィルタが適用される |
| 4 | `POST /api/orders/refetch` が正常動作する（pending生成・差分判定・フラグ更新） |
| 5 | 差分なし時：確認ボタン押下でdiff_confirmed_flag ONになる |
| 6 | 差分あり時：差分概要表示 → 確認後にpending昇格・diff_confirmed_flag ONになる |
| 7 | has_new_uninitialized=true時：確認ボタン非活性・new_uninitialized_count件数が表示される・init誘導UIが表示される |
| 8 | init完了後に自動で再取得が実行され、DiffConfirmModalが更新される |
| 9 | `POST /api/orders/diff-confirm` が has_new_uninitialized=true の場合に400/409を返す |
| 10 | `POST /api/session/start` が未確認状態でリクエストされた場合に400/409を返す |
| 11 | T5実行時に `orders:refetch_state` がU3へコピーされ削除される |
| 12 | `GET /api/orders/list` のsession_status別フラグ参照先が正しく動作する |
| 13 | SessionStatusBarにフラグ状態が正しく反映される |
| 14 | `npm run build` が通る |
| 15 | Vercelデプロイが完了する |
| 16 | 本番画面で再取得ボタン押下 → 差分確認完了 → フラグON の一連動作が確認できる |

---

## 5. 確認・報告事項

実装完了後、以下を報告すること。

- `npm run build` の結果
- Vercelデプロイの結果
- 本番画面での動作確認結果（差分なし・差分あり・未初期化注文あり の各パターン）
- 実装中に設計と乖離が生じた箇所があれば報告すること（勝手に設計変更しないこと）

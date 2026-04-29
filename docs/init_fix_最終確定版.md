# 初期化まわり最小修正指示文（最終確定版）
## DiffConfirmModal エラー判定修正 ＋ /api/orders/init 書き込み整合性改善

作成：ChatGPT監査「ほぼGO」補正2点反映済み・最終確定版
対象：Claude Code

---

## 0. 着手前に必ず確認すること（絶対禁止事項）

- **実装・修正対象は本指示文に記載した2ファイルのみ**
- **新規ファイルを作成しないこと**
- **Step 4-Cの実装には着手しないこと**
- **孤立U1（`ACD338A79F9F9CE7`）の削除・復旧は行わないこと**
- **4件の初期化再実行は、修正・build・Vercelデプロイが完了するまで禁止**

---

## 1. 修正対象ファイル

| # | ファイル | 修正内容 |
|---|---|---|
| 修正1 | `app/orders/components/DiffConfirmModal.tsx` | initエラー判定条件の修正・JSONパース失敗考慮 |
| 修正2 | `app/api/orders/init/route.ts` | index:orders書き込みをpipelineに統合・部分欠け補完 |

---

## 2. 修正1：DiffConfirmModal.tsx のエラー判定修正

### 変更箇所

L77付近のinitエラー判定条件を修正する。

### 現状（バグあり）

```typescript
if (!initData.success && initRes.status !== 200) {
  // HTTP 200 + success:false の場合、両条件が成立しないためスルーされる
  // → 後続のrefetchへ進んでしまう
}
```

### 修正後

```typescript
let initData: { success: boolean; message?: string; error?: string } | null = null;
try {
  initData = await initRes.json();
} catch {
  // JSONパース失敗時は一般文言を表示して処理を止める
  setError("初期化に失敗しました。時間をおいて再実行してください。");
  return;
}

if (!initRes.ok || !initData?.success) {
  // HTTP非200 または success:false のいずれかでエラー表示
  // APIのmessage/errorはユーザー向け一般文言のみ表示する
  // 内部構造・スタックトレース・キー名は表示しない
  const message =
    initData?.message ||
    initData?.error ||
    "初期化に失敗しました。時間をおいて再実行してください。";
  setError(message);
  return; // 後続のrefetchへ進まない
}
```

### 修正方針の詳細

- `&&`（AND）→ `||`（OR）に変更
- `initRes.status !== 200` → `!initRes.ok`（200番台全体を正常扱い）
- `initRes.json()`のJSONパース失敗を`try-catch`で捕捉し、一般文言を表示して処理を止める
- フロントに表示するメッセージはユーザー向け一般文言のみ（内部構造・キー名・スタックトレース・トークン関連情報を表示しない）
- エラー時は`return`で後続のrefetchへ進まない

### 変更しないこと

- refetch成功時の処理フロー
- モーダルの表示・非表示ロジック
- エラー表示UI（既存の`setError`を使う）
- refetch側のエラーハンドリング

---

## 3. 修正2：/api/orders/init の書き込み整合性改善

### 背景

現状、`pipeline.exec()`（U1 / snapshot / bundle書き込み）と`redis.sadd("index:orders")`が分離して実行されており、前者成功・後者失敗のケースで`index:orders`への登録漏れが発生する。

**注意：** `redis.pipeline()`は書き込みをまとめて送る手段であり、DBトランザクションと同一視しない。ただし書き込み分離を減らすことで、整合性崩れのリスクを低減できる。

### 修正方針

#### 3-1. `redis.sadd("index:orders")`をpipelineに統合する

現状の`pipeline.exec()`直後に単独で実行されている`redis.sadd("index:orders", uniqueKey)`を、pipelineに統合する。

以下はpipeline統合のイメージであり、実コードは既存の構造に合わせること。

```typescript
// pipeline統合イメージ（実コードは既存構造に合わせる）
const pipe = redis.pipeline();

// 既存：U1 / snapshot / bundle（NX保護維持・既存ロジックを変更しない）
pipe.set(`order:${uniqueKey}`, orderData, { nx: true });
pipe.set(`order_snapshot:${uniqueKey}`, snapshotData, { nx: true });
// bundle生成ロジックは既存のまま維持し、その結果をpipelineに渡す
// bundle:{bundle_group_id}の構造・同梱群の作り方・order_unique_keysの扱いを変更しない

// 修正：index:ordersへのsaddをpipelineに統合
pipe.sadd("index:orders", uniqueKey);

const results = await pipe.exec();
// resultsのエラー有無を確認し、失敗が検出された場合はsuccess:falseを返す
```

#### 3-2. bundle生成ロジックの扱い

**bundle生成ロジック自体を再設計しない。**

- 既存のbundle生成結果を維持したまま、pipeline統合のみを行う
- `bundle:{bundle_group_id}`の構造・同梱群の作り方を変更しない
- `order_unique_keys` / `order_ids`の扱いを変更しない
- 同梱群単位のbundle作成・保存ロジックが既にある場合、それを壊さずpipeline統合する

#### 3-3. 部分欠け補完の考慮

`order:{unique_key}`が既に存在する場合でも、以下の不足分があれば補完できるようにする。

| キー | NX保護 | 補完方針 |
|---|---|---|
| `order:{unique_key}` | あり（維持） | 既存を上書きしない。staff入力値（carrier / hold_flag / receipt_required / receipt_name / receipt_note等）を保護する |
| `order_snapshot:{unique_key}` | あり（維持） | 存在しない場合のみ作成 |
| `bundle:{bundle_group_id}` | あり（維持） | 存在しない場合のみ作成。既存bundle生成ロジックを維持 |
| `index:orders`（Set） | なし（saddは冪等） | 常に実行。既に存在しても問題なし |

#### 3-4. 部分欠け検出時の扱い

`pipeline.exec()`の結果に失敗が含まれる場合の扱いを以下のように明確化する。

| ケース | 扱い |
|---|---|
| 全て成功 | `success: true` を返す |
| saddのみ失敗 | `success: false` を返す |
| U1 / snapshot / bundleのいずれかが失敗 | `success: false` を返す |
| 全て失敗 | `success: false` を返す |

**部分成功状態で`success: true`を返さないこと。**

#### 3-5. エラーレスポンスの安全化

`pipeline.exec()`の結果に失敗が含まれる場合：

- 詳細エラー（pipeline結果・失敗段階・Upstashエラー内容・スタックトレース）は**サーバーログにのみ出力する**
- APIレスポンスでは`success: false`と一般文言の`message`のみ返す
- フロントに内部構造・キー名・スタックトレース・トークン関連情報を含めない

```typescript
// エラーレスポンスの例
return NextResponse.json(
  { success: false, message: "初期化に失敗しました。時間をおいて再実行してください。" },
  { status: 200 }
);
// サーバーログには詳細を出力する
console.error("[orders/init] pipeline失敗:", results);
```

#### 3-6. スタッフ入力値の保護（変更しないこと）

以下のフィールドはNX保護により上書きされないが、実装時に明示的に確認すること。

- `carrier`
- `hold_flag`
- `receipt_required`
- `receipt_name`
- `receipt_note`

#### 3-7. レスポンス構造（変更しないこと）

既存のレスポンス構造（`success: boolean`・`message: string`・`initialized`・`skipped`等のフィールド）を維持すること。

---

## 4. 修正後の確認項目

**本番URLで以下を全て確認してから完了扱いとすること。**

| # | 確認内容 | 確認方法 |
|---|---|---|
| C-1 | init成功時に`success: true`が返ること | 本番画面で「初期化を実行する」を押下 |
| C-2 | init成功時にU1 / snapshot / bundle / index:ordersの4点が全て作成されること | `npx tsx scripts/check-snapshot.ts`で件数確認 |
| C-3 | init失敗時に`success: false`が返り、DiffConfirmModalでエラーが表示されること | APIを直接叩くかモックで確認 |
| C-4 | `HTTP 200 + success: false`の場合にDiffConfirmModalがエラー表示して後続のrefetchへ進まないこと | C-3と同様 |
| C-5 | JSONパース失敗時に一般文言が表示されて後続へ進まないこと | エラーレスポンス等で確認 |
| C-6 | init後のrefetch実行でモーダルが正常な状態を示すこと | 本番画面で確認 |
| C-7 | 既存U1のcarrier / hold_flag等が上書きされていないこと | Upstash直接確認 |
| C-8 | `npm run build`が通ること | ローカルまたはVercel |
| C-9 | 未初期化4件を初期化後、U1 / snapshot / bundle / index:ordersの件数が同数増えること | `check-snapshot.ts`または突合確認 |
| C-10 | 初期化後、注文一覧に4件が表示されること | 本番画面`/orders` |
| C-11 | 初期化成功後、前回のような「ネットワークエラー」表示にならないこと | 本番画面 |
| C-12 | 初期化成功後にStep 4-B P1〜P15へ進める状態になること | 本番画面 |

---

## 5. デプロイ後に4件の初期化を再実行してよい条件

以下を**全て**満たした場合に「初期化を実行する」を押してよい。

| # | 条件 |
|---|---|
| 1 | 修正1・修正2の実装が完了していること |
| 2 | `npm run build`が通っていること |
| 3 | Vercelデプロイが完了していること |
| 4 | 本番URLで新しいデプロイが反映されていること |
| 5 | 4件の未初期化注文がBASE API上で引き続きアクティブであること |
| 6 | 初期化前のUpstash状態を確認していること |

---

## 6. 後続保持事項（今回の修正に含めないこと）

| 事項 | 扱い |
|---|---|
| 孤立U1（`ACD338A79F9F9CE7`）の削除・復旧 | 後続クリーンアップ課題として保持 |
| Step 4-B P1〜P15確認 | 本修正・デプロイ・4件初期化完了後に再開 |
| Step 4-Cへの着手 | Step 4-B本番確認完了後 |
| BASE API取得条件の大幅変更 | 不要と判断。保持不要 |

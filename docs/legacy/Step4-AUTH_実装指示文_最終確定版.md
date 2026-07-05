# Step 4-AUTH 実装指示文（最終確定版）
## NextAuth.js v4 認証・API保護の実装

作成：Step 4-AUTH仕様確定後（ChatGPT監査 条件付きGO済み）
対象：Claude Code

---

## 0. 着手前に必ず読むこと

### 参照すべき設計文書（優先順）

1. この指示文（最初に読む）
2. 実装参照文書_ClaudeCode向け.md（技術スタック・全体方針の確認）
3. 概要設計書（フェーズ2 v3）
4. DATA-01（状態管理の正文）

### 絶対禁止事項

- U1〜U4のデータ構造を変更しないこと
- U3セッション構造を変更しないこと
- `refetch_done_flag` / `diff_confirmed_flag` / `checklist_printed_flag` の意味・扱いを変更しないこと
- セッションロック条件を変更しないこと
- Step 4-B以降の業務フロー・設計を変更しないこと
- AUTH-ACCOUNT-01の後続保持方針（複数スタッフ・ハッシュ化は後続で検討）を先取りして実装しないこと
- `ADMIN_USERNAME` または `ADMIN_PASSWORD` が未設定の場合に認証成功させないこと（fail closed）
- 空文字との一致でログイン成功する実装は禁止
- `/login` や `/api/auth/*` をmiddlewareで保護してログイン不能にしないこと

---

## 1. 実装範囲

### 新規作成（4ファイル）

| ファイル | 内容 |
|---|---|
| `app/api/auth/[...nextauth]/route.ts` | NextAuth.js v4ハンドラー |
| `app/login/page.tsx` | ログイン画面UI |
| `lib/auth.ts` | NextAuth設定（authOptions）・API認証チェック共通ヘルパー（requireAuth） |
| `middleware.ts` | 認証必須パスの保護・未認証時リダイレクト |

※ `app/api/auth/[...nextauth]/route.ts` のパスは必ずこの形式とすること。

### 変更（既存業務APIファイル 12本）

各ファイルの冒頭に `requireAuth()` チェックを追加する。

| エンドポイント | ファイルパス |
|---|---|
| GET /api/orders/list | `app/api/orders/list/route.ts` |
| GET /api/orders | `app/api/orders/route.ts` |
| POST /api/orders/init | `app/api/orders/init/route.ts` |
| PATCH /api/orders/carrier | `app/api/orders/carrier/route.ts` |
| PATCH /api/orders/receipt | `app/api/orders/receipt/route.ts` |
| PATCH /api/orders/hold | `app/api/orders/hold/route.ts` |
| POST /api/orders/refetch | `app/api/orders/refetch/route.ts` |
| POST /api/orders/diff-confirm | `app/api/orders/diff-confirm/route.ts` |
| GET /api/session/current | `app/api/session/current/route.ts` |
| POST /api/session/start | `app/api/session/start/route.ts` |
| POST /api/session/end | `app/api/session/end/route.ts` |
| POST /api/session/unlock | `app/api/session/unlock/route.ts` |

### 含めないこと

- U1〜U4・U3・フラグ類のデータ構造変更
- 複数スタッフアカウント・パスワードハッシュ化（AUTH-ACCOUNT-01として後続保持）
- Step 4-B以降の業務機能（セッションロック・CSV出力・納品書・ステータス更新等）

---

## 2. 認証方式（確定）

| 項目 | 内容 |
|---|---|
| ライブラリ | NextAuth.js v4（^4.24.14 インストール済み） |
| プロバイダー | Credentials Provider |
| ログイン方式 | 単一管理者ログイン |
| 認証情報 | 環境変数 `ADMIN_USERNAME` / `ADMIN_PASSWORD` との比較 |
| セッション管理 | NextAuth.js JWTセッション |

---

## 3. 保護範囲（確定）

### 認証必須

| 対象 | 内容 |
|---|---|
| `/orders/:path*` | メイン画面および下位ページ。未認証時は `/login` へリダイレクト |
| `/api/orders/:path*` | 原則すべて認証必須 |
| `/api/session/:path*` | 原則すべて認証必須 |

**方針：今後、業務APIを追加する場合も、原則として認証必須とすること。**

### 公開のまま（middlewareで保護対象から除外）

| 対象 | 理由 |
|---|---|
| `/login` | ログイン画面。保護するとログイン不能になる |
| `/api/auth/*` | NextAuth.js内部エンドポイント。保護するとログイン不能になる |
| `/api/health` | ヘルスチェック用。存在する場合は公開のまま |
| Next.jsの静的アセット系（`/_next/*` 等） | 正常動作に必要 |

---

## 4. 各ファイルの実装仕様

### 4-1. `lib/auth.ts`

NextAuth.js の設定（`authOptions`）と、API Route用の認証チェックヘルパー（`requireAuth`）を定義する。

**authOptions の要件：**

- `providers`: Credentials Provider のみ
- `authorize` 関数内：
  - `ADMIN_USERNAME` または `ADMIN_PASSWORD` が未設定（undefined・空文字）の場合は必ず `null` を返し、認証失敗とする
  - 入力値と環境変数を比較し、一致した場合のみユーザーオブジェクトを返す
  - 不一致・未設定時は `null` を返す
  - サーバーログ上で環境変数未設定が分かるようにする（ただし、画面上に詳細情報は出さない）
- `session`: `{ strategy: "jwt" }`
- `pages`: `{ signIn: "/login" }`

**requireAuth 関数の要件：**

- Next.js App Router + NextAuth.js v4 で成立する実装にすること
- `getServerSession(authOptions)` を使う場合、Route Handler内で正常にセッション取得できることを確認すること
- `req` 引数が実装上不要になる場合は、呼び出し側とヘルパー側で型・使い方を揃えること（引数あり・なしで不整合が出ないようにする）
- セッションがない場合：`NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })` を返す
- セッションがある場合：`null` を返す（呼び出し側で `null` チェックして続行）
- 全業務APIで未認証時レスポンスを `401 { success: false, error: "Unauthorized" }` に統一すること
- 全業務APIのRoute Handlerで共通利用できる形にする

### 4-2. `app/api/auth/[...nextauth]/route.ts`

```typescript
import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
```

### 4-3. `middleware.ts`

- `matcher` で保護対象パスを指定する
- 保護対象：`/orders/:path*`・`/api/orders/:path*`・`/api/session/:path*`（`/orders` 単体も含む）
- 除外対象：`/login`・`/api/auth/:path*`・`/api/health`・`/_next/:path*`・静的ファイル系
- 未認証時の画面アクセス：`/login` へリダイレクト
- 未認証時のAPIアクセス：`401 { success: false, error: "Unauthorized" }` を返す
- NextAuth.js v4 のmiddlewareには `getToken` を使う方針を推奨する
- 理由：未認証でAPIアクセスした場合に JSON 401 を返す必要があるため、`withAuth` より `getToken` の方が柔軟に対応できる
- 実装パターン：`getToken({ req })` でトークンの有無を確認し、パスの種別（画面 / API）に応じてリダイレクトまたは 401 レスポンスを返し分ける

### 4-4. `app/login/page.tsx`

- **`"use client"` を必ず付けること**（`signIn` はクライアントサイドで呼び出すため）
- username / password の入力状態は `useState` でクライアント側で管理する
- シンプルなログインフォームUI（ユーザー名・パスワード・ログインボタン）
- `signIn("credentials", { username, password, callbackUrl: "/orders" })` を使用する
- ログイン失敗時は一般的なエラーメッセージを表示する（詳細な内部情報・環境変数の内容・サーバーエラー詳細は出さない）
- ログイン成功後は `/orders` へ遷移する
- 未ログイン状態でもアクセスできること（middlewareで保護しない）

### 4-5. 既存業務APIへの `requireAuth` 追加

各Route Handlerの先頭に以下を追加する（全12ファイル共通パターン）：

```typescript
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const authError = await requireAuth(req);
  if (authError) return authError;

  // 既存の処理をそのまま継続
  ...
}
```

- HTTPメソッド（GET / POST / PATCH）に合わせて適用すること
- 既存のビジネスロジック・Upstashアクセス・レスポンス構造は一切変更しないこと

---

## 5. 環境変数

### Vercelへの追加が必要な環境変数

実装完了・動作確認前に以下を追加し、再デプロイすること。

| 変数名 | 内容 |
|---|---|
| `ADMIN_USERNAME` | ログインID（任意の文字列） |
| `ADMIN_PASSWORD` | ログインパスワード（任意の文字列） |

※ `NEXTAUTH_SECRET` はVercel環境変数に設定済み。
※ `NEXTAUTH_URL` はVercel環境変数に設定済み。

---

## 6. 実装後の確認項目（完了条件）

**Step 4-AUTHは、実装しただけでは完了扱いにしない。以下を全て確認してから完了とする。**

### 未認証アクセスの確認

| 確認内容 | 期待結果 |
|---|---|
| 未ログインで `/orders` にアクセス | `/login` にリダイレクトされる |
| 未ログインで `/api/orders/list` にアクセス | `401 { success: false, error: "Unauthorized" }` が返る |
| 未ログインで `/api/session/current` にアクセス | `401 { success: false, error: "Unauthorized" }` が返る |
| 未ログインで `PATCH /api/orders/carrier` を実行 | `401 { success: false, error: "Unauthorized" }` が返る |
| 未ログインで `POST /api/orders/refetch` を実行 | `401 { success: false, error: "Unauthorized" }` が返る |
| 未ログインで `POST /api/session/start` を実行 | `401 { success: false, error: "Unauthorized" }` が返る |

### 公開対象の確認

| 確認内容 | 期待結果 |
|---|---|
| `/login` に未ログインでアクセス | ログイン画面が表示される（リダイレクトされない） |
| `/api/auth/*` がmiddlewareで塞がれていない | NextAuth.js内部エンドポイントが正常に応答する |
| `/api/health` が存在する場合、未ログインでアクセス | 正常に応答する |

### ログイン・認証後の確認

| 確認内容 | 期待結果 |
|---|---|
| 正しい `ADMIN_USERNAME` / `ADMIN_PASSWORD` でログイン | ログイン成功・`/orders` へ遷移する |
| 誤ったID/PWでログイン | ログイン失敗・エラーメッセージ表示 |
| ログイン後に `/orders` にアクセス | メイン画面が表示される |
| ログイン後に `/api/orders/list` にアクセス | 注文一覧が返る（既存動作と変わらない） |

### 本番確認

| 確認内容 | 期待結果 |
|---|---|
| Vercelに `ADMIN_USERNAME` / `ADMIN_PASSWORD` を追加後、再デプロイ | 本番URLで上記の確認項目が全て通る |

---

## 7. 完了判定条件

以下が全て満たされたとき、Step 4-AUTHを完了とする。

1. 上記6節の確認項目が全て通っていること
2. 本番URL（https://whatnot-shipping-app.vercel.app）での確認が完了していること
3. 既存業務APIの動作（注文一覧表示・carrier変更・hold変更・receipt変更・再取得・差分確認・セッション操作）がログイン後に正常に動作すること
4. 既存のU1〜U4データ構造・セッション構造・フラグ類に変更がないこと

---

## 8. 完了後に行うこと（Step 4-AUTH完了後）

1. 本番動作確認結果を岡本さんへ報告する
2. Step 4-Bの実装は、Step 4-AUTH完了確認後に別途指示を受けてから着手する
3. Step 4-Bの実装指示文は、この指示文には含まれていない。勝手に着手しないこと

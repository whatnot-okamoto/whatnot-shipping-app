import { getServerSession } from "next-auth/next";
import { notFound, redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { isDevelopmentRuntime, resolveRuntimeConfig } from "@/lib/runtime-mode";

const VALID_ERRORS = [
  "denied",
  "session_mismatch",
  "start_failed",
  "state_invalid",
  "token_exchange_failed",
  "save_failed",
] as const;

export default async function ReadonlyReauthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDevelopmentRuntime(resolveRuntimeConfig())) notFound();

  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const params = await searchParams;
  const successParam =
    typeof params.success === "string" ? params.success : null;
  const errorParam = typeof params.error === "string" ? params.error : null;
  const success = successParam === "true";
  const displayError =
    errorParam && (VALID_ERRORS as readonly string[]).includes(errorParam)
      ? errorParam
      : null;

  return (
    <main className="p-8 max-w-lg mx-auto">
      <h1 className="text-xl font-bold mb-4">Development BASE read-only認証</h1>
      <p className="mb-4 text-gray-700">
        Development専用のBASE OAuth認証です。認可画面では、権限が
        <strong> read_ordersだけ</strong>であることを確認してください。
        write_ordersや追加権限が表示された場合は承認せず、この画面へ戻ってください。
      </p>
      <p className="mb-6 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-3">
        外部OAuth認可は、専用client・失効／cleanup手順・platform log確認が完了し、
        別の明示承認を得た場合だけ実行してください。
      </p>

      {success && (
        <p className="mb-4 text-green-700 bg-green-50 border border-green-200 rounded p-3">
          read-only認証情報を保存しました。自動で注文データは取得していません。
        </p>
      )}

      {displayError && (
        <p className="mb-4 text-red-700 bg-red-50 border border-red-200 rounded p-3">
          read-only認証を完了できませんでした。（エラーコード：{displayError}）
        </p>
      )}

      <a
        href="/api/base/readonly-reauth/start"
        className="inline-block px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
      >
        read-only認証を開始する
      </a>

      <div className="mt-6">
        <a href="/orders" className="text-blue-600 hover:underline">
          ← 注文一覧へ戻る
        </a>
      </div>
    </main>
  );
}

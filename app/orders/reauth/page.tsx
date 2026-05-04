import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";

const VALID_ERRORS = ["state_mismatch", "token_exchange_failed", "save_failed"] as const;

export default async function ReauthPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const success = params.success === "true";
  const errorParam = params.error;
  const displayError =
    errorParam && (VALID_ERRORS as readonly string[]).includes(errorParam)
      ? errorParam
      : null;

  return (
    <main className="p-8 max-w-lg mx-auto">
      <h1 className="text-xl font-bold mb-4">BASE 再認証</h1>
      <p className="mb-6 text-gray-700">
        BASEとの接続を再認証します。ボタンを押すとBASEの認証画面に移動します。
      </p>

      {success && (
        <p className="mb-4 text-green-700 bg-green-50 border border-green-200 rounded p-3">
          再認証が完了しました。続けてBASE API接続確認を行ってください。
        </p>
      )}

      {displayError && (
        <p className="mb-4 text-red-700 bg-red-50 border border-red-200 rounded p-3">
          再認証に失敗しました。もう一度お試しください。（エラーコード：{displayError}）
        </p>
      )}

      <a
        href="/api/base/reauth/start"
        className="inline-block px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
      >
        再認証する
      </a>

      <div className="mt-6">
        <a href="/orders" className="text-blue-600 hover:underline">
          ← 注文一覧へ戻る
        </a>
      </div>
    </main>
  );
}

"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { signIn } from "next-auth/react";

type LoginStatus =
  | "LOGIN_REQUIRED"
  | "LOGIN_IN_PROGRESS"
  | "LOGIN_ACCEPTED"
  | "STOP_LOGIN_REJECTED"
  | "STOP_LOGIN_ERROR";

export function PreflightLoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<LoginStatus>("LOGIN_REQUIRED");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setStatus("LOGIN_IN_PROGRESS");

    try {
      const result = await signIn("credentials", {
        username,
        password,
        callbackUrl: "/development/readonly-reauth/preflight-login",
        redirect: false,
      });
      setStatus(
        result?.ok === true ? "LOGIN_ACCEPTED" : "STOP_LOGIN_REJECTED"
      );
    } catch {
      setStatus("STOP_LOGIN_ERROR");
    } finally {
      setPassword("");
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm bg-white rounded-lg shadow p-8">
        <h1 className="text-xl font-semibold text-gray-800 mb-6 text-center">
          Development preflight login
        </h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="development-preflight-username"
              className="block text-sm text-gray-700 mb-1"
            >
              Username
            </label>
            <input
              id="development-preflight-username"
              name="username"
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              autoComplete="username"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label
              htmlFor="development-preflight-password"
              className="block text-sm text-gray-700 mb-1"
            >
              Password
            </label>
            <input
              id="development-preflight-password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-blue-600 text-white rounded py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Authenticate
          </button>
          <output aria-live="polite" className="text-sm text-gray-700">
            {status}
          </output>
        </form>
      </div>
    </main>
  );
}

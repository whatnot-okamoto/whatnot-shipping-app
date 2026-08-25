"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/orders", label: "出荷業務" },
  { href: "/receipts", label: "領収書発行" },
] as const;

export default function AppNavigation() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="業務メニュー"
      className="border-b border-gray-200 bg-white"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-1 px-4 py-2">
        {LINKS.map((link) => {
          const active = pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

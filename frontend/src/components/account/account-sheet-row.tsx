"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { authClient, useAccountState } from "@/lib/auth-client";
import Avatar from "./avatar";

/**
 * The account entry in the phone "More" sheet (`mobile-more-sheet.tsx`).
 *
 * The header control exists on phones too, but a 32px avatar in a crowded bar
 * is easy to miss and its menu is a small target; the sheet is where a phone
 * visitor already goes for everything that is not a primary destination, so
 * the account lives here as a full-width row as well. Renders nothing when
 * accounts are unavailable, matching the header.
 */
export default function AccountSheetRow({ onNavigate }: { onNavigate: () => void }) {
  const account = useAccountState();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [signingOut, setSigningOut] = useState(false);

  if (account.status === "unavailable" || account.status === "loading") return null;

  const rowClass =
    "flex items-center gap-3 rounded-xl px-3 py-3 bg-veil/5 border border-white/[0.06] active:bg-veil/10 transition-colors";

  if (account.status === "signed-out") {
    return (
      <Link href="/signin" onClick={onNavigate} className={`${rowClass} mb-4`}>
        <span
          className="material-symbols-outlined text-[22px] text-primary flex-none"
          aria-hidden="true"
        >
          account_circle
        </span>
        <span className="min-w-0">
          <span className="block font-semibold text-sm text-on-background">Sign in</span>
          <span className="block text-xs text-warm-400 leading-snug mt-0.5">
            Optional — sync favourites and chat history across devices
          </span>
        </span>
      </Link>
    );
  }

  const { user } = account;

  async function signOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      setSigningOut(false);
      onNavigate();
      if (pathname.startsWith("/account")) router.push("/");
      router.refresh();
    }
  }

  return (
    <div className="flex gap-2 mb-4">
      <Link href="/account" onClick={onNavigate} className={`${rowClass} flex-1 min-w-0`}>
        <Avatar name={user.name} email={user.email} image={user.image} size={32} />
        <span className="min-w-0">
          <span className="block font-semibold text-sm text-on-background truncate">
            {user.name || "Account"}
          </span>
          <span className="block text-xs text-warm-400 truncate">{user.email}</span>
        </span>
      </Link>
      <button
        type="button"
        onClick={signOut}
        disabled={signingOut}
        className="flex-none min-w-[64px] rounded-xl px-3 bg-veil/5 border border-white/[0.06] text-xs font-semibold text-warm-200 active:bg-veil/10 disabled:opacity-60"
      >
        {signingOut ? "…" : "Sign out"}
      </button>
    </div>
  );
}

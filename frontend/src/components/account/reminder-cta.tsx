"use client";

import Link from "next/link";
import { useAccountState } from "@/lib/auth-client";

/**
 * "Get an email before the race", under the home page's countdown.
 *
 * The countdown is the moment someone is thinking about the next session, and
 * the reminders that answer it lived only inside /account, behind a sign-in
 * nobody had been given a reason to make. This puts the door where the need is.
 *
 * Signed out: to the Create account tab with the reason stated, and back to the
 * reminders settings afterwards (`next`). Signed in: straight to the settings.
 * Nothing while the session is loading (it would flash the wrong link) or where
 * accounts are not configured at all.
 */
export default function ReminderCta() {
  const account = useAccountState();
  if (account.status === "loading" || account.status === "unavailable") return null;

  const href =
    account.status === "signed-in"
      ? "/account#reminders"
      : "/signin?mode=signup&reason=reminders&next=%2Faccount%23reminders";

  return (
    <p className="mt-4">
      <Link href={href} className="font-semibold text-xs text-primary hover:underline">
        Get an email before the race →
      </Link>
    </p>
  );
}

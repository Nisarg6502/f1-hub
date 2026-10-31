"use client";

import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

/**
 * The browser half of Better Auth.
 *
 * No `baseURL`: the auth routes live on this same origin under `/api/auth`,
 * which is the client's default, so nothing environment-specific is baked
 * into the bundle and the CSP's `connect-src 'self'` already covers it.
 *
 * `useSession()` from here is what every account surface renders from. When
 * accounts are not configured the session endpoint answers 404, the hook
 * reports an error, and those surfaces render nothing — see
 * `useAccountState` below.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});

export type AccountState =
  /** Still asking the server. Render a fixed-size placeholder. */
  | { status: "loading" }
  /** Accounts are not configured on this deployment. Render nothing. */
  | { status: "unavailable" }
  | { status: "signed-out" }
  | {
      status: "signed-in";
      user: { id: string; name: string; email: string; image?: string | null };
    };

/**
 * Collapse Better Auth's `{data, isPending, error}` into the four states the
 * UI actually distinguishes. Kept in one place so the header, the mobile
 * sheet and the account page cannot disagree about what "unavailable" means.
 */
export function useAccountState(): AccountState {
  const { data, isPending, error } = authClient.useSession();
  if (isPending) return { status: "loading" };
  if (error) {
    return error.status === 404 ? { status: "unavailable" } : { status: "signed-out" };
  }
  if (!data) return { status: "signed-out" };
  const { id, name, email, image } = data.user;
  return { status: "signed-in", user: { id, name, email, image } };
}

/** Initials for the avatar fallback: "Lando Norris" → "LN", "max" → "M". */
export function initialsFor(name: string | null | undefined, email?: string): string {
  const source = (name ?? "").trim() || (email ?? "").split("@")[0] || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : parts[0]?.[0] ?? "?";
  return letters.toUpperCase();
}

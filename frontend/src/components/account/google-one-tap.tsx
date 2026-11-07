"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient, googleClientIdInBrowser, useAccountState } from "@/lib/auth-client";

/**
 * Google One Tap: the "Continue as <you>" prompt in the top-right corner.
 *
 * Renders nothing itself — Google draws the prompt (natively, through FedCM,
 * in browsers that support it). This only decides whether to ask:
 *
 *   - accounts are on (`<html data-accounts="on">`, folded into
 *     `useAccountState`) and Google is configured (a client ID on `<html>`);
 *   - the visitor is signed out — never decided while the session is still
 *     loading, so a signed-in visitor cannot see it flash;
 *   - not on /signin, which already has a "Continue with Google" button, and
 *     a second Google prompt over it is noise.
 *
 * At most once per page load. Client-side navigation does not re-ask, and
 * Google's own cooldown (which grows with each dismissal) decides whether a
 * later full load shows it again — there is deliberately no retry here (see
 * `promptOptions` in `lib/auth-client.ts`).
 *
 * On success the user stays where they are: the session store is told to
 * refetch, so the header avatar appears, and server components re-render.
 */
let askedThisPageLoad = false;

export default function GoogleOneTap() {
  const account = useAccountState();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const eligible =
    account.status === "signed-out" &&
    Boolean(googleClientIdInBrowser) &&
    !pathname.startsWith("/signin");

  useEffect(() => {
    if (!eligible) {
      // A prompt still open from an earlier page (navigating to /signin, or
      // signing in another way) should not sit on top of what comes next.
      if (askedThisPageLoad) {
        (
          window as Window & { google?: { accounts?: { id?: { cancel?: () => void } } } }
        ).google?.accounts?.id?.cancel?.();
      }
      return;
    }
    if (askedThisPageLoad) return;
    askedThisPageLoad = true;
    authClient
      .oneTap({
        autoSelect: false,
        // Passing fetchOptions (and no callbackURL) is what stops the plugin
        // from navigating to "/" after sign-in.
        fetchOptions: {
          onSuccess: () => {
            authClient.$store.notify("$sessionSignal");
            router.refresh();
          },
        },
      })
      .catch(() => {
        // The GIS script failed to load (offline, blocked by an extension).
        // One Tap is an optional shortcut; the Sign in button still works.
      });
  }, [eligible, router]);

  return null;
}

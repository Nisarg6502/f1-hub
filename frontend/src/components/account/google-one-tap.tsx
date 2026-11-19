"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient, googleClientIdInBrowser, useAccountState } from "@/lib/auth-client";
import {
  ACCOUNT_MOMENT_EVENT,
  isQuietPath,
  recordVisitDay,
  shouldOfferOneTap,
} from "@/lib/one-tap";

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
 *   - it has been EARNED (`lib/one-tap.ts`): a third visit on a third day, or
 *     something worth saving this visit (spoiler-free mode on, a home page
 *     arranged, an assistant answer). It used to fire on the first page of the
 *     first visit, before there was anything to save;
 *   - not on a replay, /signin or /account, where it is noise or a duplicate.
 *
 * At most once per page load. Client-side navigation does not re-ask once it
 * has, and Google's own cooldown (which grows with each dismissal) decides
 * whether a later full load shows it again — there is deliberately no retry here
 * (see `promptOptions` in `lib/auth-client.ts`).
 *
 * A moment that happens on a quiet page (an answer during a replay) is
 * remembered, and the prompt follows once the visitor reaches a page where it
 * is welcome.
 *
 * On success the user stays where they are: the session store is told to
 * refetch, so the header avatar appears, and server components re-render.
 */
let askedThisPageLoad = false;
// Counted once per page load. `recordVisitDay` is idempotent within a day, but
// there is no reason to read and write storage every time the path changes.
let visitDaysThisLoad: number | null = null;

function visitDaysSoFar(): number {
  if (visitDaysThisLoad === null) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      // Blocked site data: counts as a first visit, which never prompts.
    }
    visitDaysThisLoad = recordVisitDay(storage, new Date());
  }
  return visitDaysThisLoad;
}

function cancelPrompt() {
  (
    window as Window & { google?: { accounts?: { id?: { cancel?: () => void } } } }
  ).google?.accounts?.id?.cancel?.();
}

export default function GoogleOneTap() {
  const account = useAccountState();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const hadMoment = useRef(false);
  const signedOutWithGoogle = account.status === "signed-out" && Boolean(googleClientIdInBrowser);

  const maybeAsk = useCallback(() => {
    if (!signedOutWithGoogle || askedThisPageLoad) return;
    if (!shouldOfferOneTap({ visitDays: visitDaysSoFar(), hadMoment: hadMoment.current, pathname })) {
      return;
    }
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
  }, [signedOutWithGoogle, pathname, router]);

  useEffect(() => {
    if (!signedOutWithGoogle || isQuietPath(pathname)) {
      // A prompt still open from an earlier page (navigating to /signin or a
      // replay, or signing in another way) should not sit on top of what
      // comes next.
      if (askedThisPageLoad) cancelPrompt();
      return;
    }
    maybeAsk();
  }, [signedOutWithGoogle, pathname, maybeAsk]);

  useEffect(() => {
    const onMoment = () => {
      hadMoment.current = true;
      maybeAsk();
    };
    window.addEventListener(ACCOUNT_MOMENT_EVENT, onMoment);
    return () => window.removeEventListener(ACCOUNT_MOMENT_EVENT, onMoment);
  }, [maybeAsk]);

  return null;
}

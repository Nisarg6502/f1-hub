"use client";

import { useEffect, useEffectEvent } from "react";
import { useRouter } from "next/navigation";
import {
  LAST_SYNCED_USER_KEY,
  createDebouncedPatch,
  createSyncedHomeLayoutStorage,
  homeLayoutToPreference,
  normaliseSpoilerCookie,
  planInitialSync,
} from "@/lib/account-sync";
import { useAccountState } from "@/lib/auth-client";
import {
  createLocalHomeLayoutStorage,
  setHomeLayoutStorage,
} from "@/lib/home-layout";
import { usePreferences } from "@/lib/preferences-client";
import { parseSpoilerCookie } from "@/lib/spoilers";
import {
  onSpoilerCookieWrite,
  readSpoilerCookie,
  writeSpoilerCookie,
} from "@/lib/spoilers-client";

/**
 * Keeps a signed-in visitor's home layout and spoiler settings in their
 * account. Renders nothing; mounted once in the root layout. The rules live
 * in `lib/account-sync.ts`.
 *
 * Without `<html data-accounts="on">` (accounts not configured) this is
 * inert: the inner component is never mounted, so no hook runs and nothing
 * is fetched. Guests get the inner component but `usePreferences()` reports
 * `"guest"` for them and nothing below the status check runs.
 */
const accountsOn =
  typeof document !== "undefined" && document.documentElement.dataset.accounts === "on";

/** The running sync's flush, while one is running. */
let activeFlush: (() => Promise<void>) | null = null;

/**
 * Send any debounced change now. Sign-out paths await this BEFORE ending the
 * session: once the session is gone the store refuses the write, and a
 * change made in the last second before signing out would be lost.
 */
export async function flushAccountSync(): Promise<void> {
  await activeFlush?.();
}

function readLastUser(): string | null {
  try {
    return window.localStorage.getItem(LAST_SYNCED_USER_KEY);
  } catch {
    return null;
  }
}

function writeLastUser(userId: string): void {
  try {
    window.localStorage.setItem(LAST_SYNCED_USER_KEY, userId);
  } catch {
    // Privacy mode. Without the stamp a later sign-in treats local copies
    // as a guest's, which is the behaviour before this key existed.
  }
}

export default function AccountSync() {
  return accountsOn ? <AccountSyncActive /> : null;
}

function AccountSyncActive() {
  const router = useRouter();
  const account = useAccountState();
  const userId = account.status === "signed-in" ? account.user.id : null;
  const { status, preferences, update } = usePreferences();
  // The account as it stands when the merge runs; not a dependency, because
  // our own uploads change it and must not re-run the merge.
  const accountNow = useEffectEvent(() => preferences);
  const ready = status === "ready" && userId !== null;

  useEffect(() => {
    if (!ready || userId === null) return;

    const saver = createDebouncedPatch((patch) => update(patch));

    // Initial merge: account wins where it has a value, else upload local.
    // Local copies another account left behind (a shared browser) are never
    // uploaded into this one; no stamp at all means a guest's own choices.
    const local = createLocalHomeLayoutStorage();
    const lastUser = readLastUser();
    const plan = planInitialSync(accountNow(), {
      homeLayout: local.load(),
      spoilerCookie: readSpoilerCookie(),
      mayUpload: lastUser === null || lastUser === userId,
    });
    writeLastUser(userId);

    // The cookie value this tab last agreed with the account on; a write of
    // the same value (our own hydration below) is not a change to upload.
    let syncedSpoilers = normaliseSpoilerCookie(readSpoilerCookie());

    const storage = createSyncedHomeLayoutStorage(local, (layout) =>
      saver.schedule({ homeLayout: homeLayoutToPreference(layout) })
    );
    setHomeLayoutStorage(storage);
    if (plan.homeLayout) storage.replace(plan.homeLayout);

    if (plan.spoilerCookie !== null) {
      syncedSpoilers = plan.spoilerCookie;
      if (writeSpoilerCookie(parseSpoilerCookie(plan.spoilerCookie))) {
        // Server components rendered from the old cookie; re-render them.
        router.refresh();
      }
    }

    if (Object.keys(plan.upload).length > 0) void update(plan.upload);

    const offSpoilers = onSpoilerCookieWrite((value) => {
      if (value === syncedSpoilers) return;
      syncedSpoilers = value;
      saver.schedule({ spoilers: value });
    });

    // A hidden tab may be closed without warning; send what is queued.
    const onHide = () => {
      if (document.visibilityState === "hidden") void saver.flush();
    };
    const onPageHide = () => void saver.flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    activeFlush = saver.flush;

    return () => {
      // Signed out, or another user signed in. The session has already
      // changed, so anything still queued could not reach the old account
      // and must not reach the new one: drop it. Sign-out paths call
      // `flushAccountSync()` first, so normally nothing is queued here.
      saver.cancel();
      if (activeFlush === saver.flush) activeFlush = null;
      offSpoilers();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      setHomeLayoutStorage(createLocalHomeLayoutStorage());
    };
  }, [ready, userId, router, update]);

  return null;
}

"use client";

import { useEffect, useEffectEvent } from "react";
import { useRouter } from "next/navigation";
import {
  createDebouncedPatch,
  createSyncedHomeLayoutStorage,
  homeLayoutToPreference,
  normaliseSpoilerCookie,
  planInitialSync,
} from "@/lib/account-sync";
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

export default function AccountSync() {
  return accountsOn ? <AccountSyncActive /> : null;
}

function AccountSyncActive() {
  const router = useRouter();
  const { status, preferences, update } = usePreferences();
  // The account as it stands when the merge runs; not a dependency, because
  // our own uploads change it and must not re-run the merge.
  const accountNow = useEffectEvent(() => preferences);
  const ready = status === "ready";

  useEffect(() => {
    if (!ready) return;

    const saver = createDebouncedPatch((patch) => {
      void update(patch);
    });

    // Initial merge: account wins where it has a value, else upload local.
    const local = createLocalHomeLayoutStorage();
    const plan = planInitialSync(accountNow(), {
      homeLayout: local.load(),
      spoilerCookie: readSpoilerCookie(),
    });

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
      if (document.visibilityState === "hidden") saver.flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", saver.flush);

    return () => {
      // Signed out (or another user signed in): stop syncing. Anything still
      // queued belonged to the session that just ended and is sent now,
      // while the old session cookie may still be valid; if it is not, the
      // store refuses the write without a request.
      saver.flush();
      offSpoilers();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", saver.flush);
      setHomeLayoutStorage(createLocalHomeLayoutStorage());
    };
  }, [ready, router, update]);

  return null;
}

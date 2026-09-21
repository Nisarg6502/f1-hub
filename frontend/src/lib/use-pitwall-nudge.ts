"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * One-time discoverability nudge for the Pitwall Assistant trigger.
 *
 * Namespaced like `apex.consent.analytics` (`analytics.ts`) and
 * `apex.watch.*` (`watch-preferences.ts`) — this app's existing convention for
 * a localStorage key. Gated on the device, not the tab or the session, so a
 * visitor sees this once ever, not once per page load.
 */
const STORAGE_KEY = "apex.pitwallAssistant.nudgeSeen";

/** How long the nudge waits before appearing, so it doesn't compete with the
 *  page's own first paint. */
const SHOW_DELAY_MS = 1600;
/** How long an ignored nudge stays up before it dismisses itself. A nudge
 *  nobody interacts with is not worth leaving on screen forever. */
const AUTO_HIDE_MS = 8000;

function readSeen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Storage disabled or unavailable (Safari private mode, etc.) — treat as
    // "already seen" so a visitor is never nagged just because their browser
    // can't remember that they weren't.
    return true;
  }
}

function writeSeen(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Best-effort only — worst case the nudge reappears next visit.
  }
}

export function usePitwallNudge() {
  const [visible, setVisible] = useState(false);

  const dismiss = useCallback(() => {
    setVisible(false);
    writeSeen();
  }, []);

  useEffect(() => {
    if (readSeen()) return;
    const showTimer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    const hideTimer = setTimeout(() => {
      setVisible(false);
      writeSeen();
    }, SHOW_DELAY_MS + AUTO_HIDE_MS);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };
  }, []);

  return { visible, dismiss };
}

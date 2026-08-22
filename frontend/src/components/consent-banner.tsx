"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import {
  MEASUREMENT_ID,
  isRegulatedRegion,
  readConsent,
  resolveTimeZone,
  writeConsent,
  type ConsentChoice,
} from "@/lib/analytics";

/**
 * Whether this visitor still has to be asked.
 *
 * `useSyncExternalStore` rather than `useState` + an effect, matching
 * `useWebglSupported` in `track3d/use-track-geometry.ts`, and for the same
 * reason: the answer depends on values that exist only in a browser -- the
 * timezone and `localStorage` -- so it cannot be computed during a server
 * render, and computing it in an effect means a `setState` that lints as a
 * cascading render because that is exactly what it is.
 *
 * The server snapshot is `false`, so the markup the server sends never contains
 * a banner. That matters beyond correctness: a banner in the server HTML would
 * flash for every visitor on earth, including the ones who must never see it,
 * until hydration corrected it.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function shouldAsk(): boolean {
  if (!MEASUREMENT_ID) return false;
  if (!isRegulatedRegion(resolveTimeZone())) return false;
  // `null` is "never asked". A stored answer of either kind ends the question
  // permanently -- declining is a decision, not a deferral.
  return readConsent() === null;
}

/** Never ask during a server render; there is nothing there to ask about. */
function neverAsk(): boolean {
  return false;
}

/**
 * Asks EU/UK visitors before `_ga` is written. Nobody else ever sees it.
 *
 * Deliberately not a modal and not a blocker: it does not trap focus, does not
 * dim the page and does not stop anyone reading the site. A visitor who ignores
 * it entirely stays in the denied default, which is the correct outcome and
 * takes no interaction at all to reach.
 *
 * Both buttons are the same size and weight. A large "Allow" beside a grey
 * whisper of a "Decline" is the pattern regulators call a dark one, and it
 * would be sitting directly above a link to a page promising honesty.
 *
 * Positioned above the mobile bottom bar rather than over it -- that bar is the
 * only navigation below 1024px, and covering it would strand a visitor on
 * whatever page they landed on until they answered.
 */
export default function ConsentBanner() {
  const visible = useSyncExternalStore(subscribe, shouldAsk, neverAsk);

  if (!visible) return null;

  const decide = (choice: ConsentChoice) => {
    writeConsent(choice);
    if (choice === "granted") {
      window.gtag?.("consent", "update", { analytics_storage: "granted" });
    }
    // Re-reads `shouldAsk`, which now finds a stored answer and returns false.
    listeners.forEach((listener) => listener());
  };

  return (
    <div
      role="dialog"
      aria-label="Analytics consent"
      className="fixed bottom-[76px] lg:bottom-4 left-0 right-0 lg:left-4 lg:right-auto lg:max-w-[380px] z-[100] mx-3 lg:mx-0 rounded-2xl bg-surface-container-low/95 backdrop-blur-xl border border-white/[0.10] shadow-[0_10px_40px_rgba(0,0,0,0.5)] px-5 py-4"
    >
      <p className="font-medium text-[13px] leading-relaxed text-warm-200">
        APEX uses Google Analytics to count visits and see which pages get used.
        No accounts, no ads, and nothing you type is sent to it.{" "}
        <Link
          href="/privacy"
          className="underline text-warm-100 hover:text-on-background transition-colors"
        >
          What it collects
        </Link>
        .
      </p>
      <div className="flex gap-2.5 mt-3.5">
        <button
          type="button"
          onClick={() => decide("granted")}
          className="flex-1 min-h-[40px] rounded-xl bg-primary-container text-on-primary-container font-semibold text-[13px] hover:brightness-110 transition"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => decide("denied")}
          className="flex-1 min-h-[40px] rounded-xl border border-white/[0.14] font-semibold text-[13px] text-warm-200 hover:bg-white/[0.05] transition"
        >
          Decline
        </button>
      </div>
    </div>
  );
}

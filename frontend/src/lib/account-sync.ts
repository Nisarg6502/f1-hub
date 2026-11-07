/**
 * Account sync: the rules for moving a signed-in visitor's home layout and
 * spoiler settings between this browser and their account.
 *
 * Pure and free of React and the DOM, so every decision is unit-tested;
 * `components/account-sync.tsx` is the thin client half that wires these to
 * the preferences store, the home-layout store and the spoiler cookie.
 *
 * ## The model
 *
 * The browser's own storage (localStorage for the layout, the `apex_spoilers`
 * cookie for spoilers) stays the thing the app reads. For a signed-in visitor
 * it is a CACHE of the account:
 *
 *   - On load (and so also right after signing in), `planInitialSync` decides
 *     per namespace: if the account holds a value, the account wins and the
 *     local copy is overwritten; if it does not, a local value the visitor
 *     actually chose is uploaded. A local value that is just the app default
 *     is not uploaded, so signing in on a fresh browser never writes defaults
 *     over nothing.
 *   - While signed in, every local change is uploaded, debounced
 *     (`createDebouncedPatch`), so dragging widgets around is one write, not
 *     twenty.
 *   - Guests, and deployments without accounts, never reach any of this.
 *   - Local copies left by a DIFFERENT account on a shared browser
 *     (`LAST_SYNCED_USER_KEY`) and an unreadable spoiler cookie are never
 *     uploaded; the account still wins where it has a value.
 *
 * Favourites are not here: they have no local copy. They are an account-only
 * preference written through `useFavourites()`, so there is nothing to merge.
 *
 * ## Stored shapes
 *
 *   homeLayout: `{ version, items: [{ id, type, size }] }` — the same JSON
 *     `serialiseHomeLayout` writes to localStorage. Read back through
 *     `parseHomeLayout`, so a layout from a newer or older build gets the
 *     same migration and validation a local one does.
 *   spoilers:   the cookie value itself (`v2|1|7|…`), a string. One format,
 *     one parser (`parseSpoilerCookie`), and it already fails closed.
 *
 * A reset-to-default layout is uploaded as the default layout, never as
 * `null`: an absent account value means "never chosen" and would let another
 * browser's custom layout win on its next load, undoing the reset.
 */

import {
  isDefaultLayout,
  layoutsEqual,
  parseHomeLayout,
  serialiseHomeLayout,
  type HomeLayout,
  type HomeLayoutStorage,
} from "./home-layout";
import type { Preferences, PreferencesPatch } from "./preferences";
import { parseSpoilerCookie, serializeSpoilerPrefs } from "./spoilers";

/**
 * localStorage key naming the account this browser's local copies were last
 * synced with. Lets a sign-in tell "a guest's own choices" (upload them) from
 * "the previous user's leftovers on a shared browser" (never upload them into
 * someone else's account).
 */
export const LAST_SYNCED_USER_KEY = "apex.account.lastUser";

/* ------------------------------- converters ------------------------------- */

export function homeLayoutToPreference(layout: HomeLayout): unknown {
  return JSON.parse(serialiseHomeLayout(layout));
}

/** The layout an account value stands for, or null when there is none. */
export function homeLayoutFromPreference(value: unknown): HomeLayout | null {
  if (value === undefined || value === null) return null;
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    return null;
  }
  return parseHomeLayout(raw);
}

/**
 * A cookie value normalised to what `writeSpoilerCookie` would write, or ""
 * for "no cookie". Normalising means a v1 cookie or a percent-encoded one
 * compares equal to the same settings written fresh.
 */
export function normaliseSpoilerCookie(raw: string | null | undefined): string {
  if (!raw) return "";
  return serializeSpoilerPrefs(parseSpoilerCookie(raw));
}

/**
 * Whether a raw cookie is one this app wrote, as opposed to damage that
 * `parseSpoilerCookie` reads as its fail-closed fallback. Damage protects the
 * visitor on this device; it must not be uploaded and follow them everywhere.
 */
export function isReadableSpoilerCookie(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return false;
  }
  const parts = value.split("|");
  const shaped =
    (parts.length === 5 && parts[0] === "v1") || (parts.length === 6 && parts[0] === "v2");
  return shaped && (parts[1] === "0" || parts[1] === "1");
}

/** The cookie value an account value stands for, or null when there is none. */
export function spoilersFromPreference(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return normaliseSpoilerCookie(value);
}

/* ------------------------------ initial merge ------------------------------ */

export interface LocalState {
  homeLayout: HomeLayout;
  /** The raw `apex_spoilers` cookie value, "" when absent. */
  spoilerCookie: string;
  /**
   * False when the local copies were last synced with a DIFFERENT account
   * (a shared browser). They are then never uploaded; the account still
   * wins where it has a value. Defaults to true.
   */
  mayUpload?: boolean;
}

export interface SyncPlan {
  /** Apply this layout locally (the account's), or null to leave local alone. */
  homeLayout: HomeLayout | null;
  /** Write this cookie value locally (the account's), or null to leave it. */
  spoilerCookie: string | null;
  /** What to upload. Empty when the account already had everything. */
  upload: PreferencesPatch;
}

export function planInitialSync(account: Preferences, local: LocalState): SyncPlan {
  const plan: SyncPlan = { homeLayout: null, spoilerCookie: null, upload: {} };
  const mayUpload = local.mayUpload ?? true;

  const accountLayout = homeLayoutFromPreference(account.homeLayout);
  if (accountLayout) {
    if (!layoutsEqual(accountLayout, local.homeLayout)) plan.homeLayout = accountLayout;
  } else if (mayUpload && !isDefaultLayout(local.homeLayout)) {
    plan.upload.homeLayout = homeLayoutToPreference(local.homeLayout);
  }

  const accountSpoilers = spoilersFromPreference(account.spoilers);
  const localSpoilers = normaliseSpoilerCookie(local.spoilerCookie);
  if (accountSpoilers !== null) {
    if (accountSpoilers !== localSpoilers) plan.spoilerCookie = accountSpoilers;
  } else if (mayUpload && isReadableSpoilerCookie(local.spoilerCookie)) {
    plan.upload.spoilers = localSpoilers;
  }

  return plan;
}

/* -------------------------------- debounce -------------------------------- */

export interface DebouncedPatch {
  /** Queue a namespace's new value; replaces any queued value for it. */
  schedule(patch: PreferencesPatch): void;
  /** Send whatever is queued now; resolves when the send has finished. */
  flush(): Promise<void>;
  /** Drop whatever is queued without sending (sign-out). */
  cancel(): void;
}

/**
 * Coalesces writes into one PUT per quiet period. Namespaces are merged
 * key by key, latest wins, which matches the server's own rule (each key
 * replaces its namespace wholesale).
 */
export function createDebouncedPatch(
  send: (patch: PreferencesPatch) => unknown,
  delayMs = 1000
): DebouncedPatch {
  let pending: PreferencesPatch = {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (Object.keys(pending).length === 0) return;
    const patch = pending;
    pending = {};
    await send(patch);
  };

  return {
    schedule(patch) {
      pending = { ...pending, ...patch };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = {};
    },
  };
}

/* ---------------------------- layout storage ---------------------------- */

export interface SyncedHomeLayoutStorage extends HomeLayoutStorage {
  /** Overwrite the local copy with the account's and tell the store, without
   * reporting it as a local change (it must not be uploaded back). */
  replace(layout: HomeLayout): void;
}

/**
 * The home-layout storage for a signed-in visitor: the local storage it
 * wraps keeps doing all the persisting, and every save the grid makes is
 * also reported to `onLocalSave` for upload. Installed through
 * `setHomeLayoutStorage`, the seam `home-layout.ts` left for exactly this.
 */
export function createSyncedHomeLayoutStorage(
  base: HomeLayoutStorage,
  onLocalSave: (layout: HomeLayout) => void
): SyncedHomeLayoutStorage {
  const external = new Set<() => void>();
  return {
    load: () => base.load(),
    save(layout) {
      base.save(layout);
      onLocalSave(layout);
    },
    subscribe(onExternalChange) {
      external.add(onExternalChange);
      const detach = base.subscribe(onExternalChange);
      return () => {
        external.delete(onExternalChange);
        detach();
      };
    },
    replace(layout) {
      base.save(layout);
      for (const listener of external) listener();
    },
  };
}

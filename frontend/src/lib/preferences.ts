/**
 * The preferences contract: what a signed-in user can store, and the rules a
 * write has to pass before it reaches MongoDB.
 *
 * This module is the seam later features plug into. The home-layout and
 * spoiler-free branches each own a namespace here without owning this file:
 * they read and write their key through `usePreferences()` and the
 * `/api/me/preferences` route, and the only thing this file knows about their
 * data is how big it may be. That is deliberate. If `homeLayout` were
 * validated field by field here, every change to the home page's widget list
 * would also be a change to the accounts code, and two branches would be
 * editing one validator.
 *
 * Kept free of React, Next and Mongo so the rules can be tested as plain
 * functions and the route handler, the client hook and the export can all
 * share one definition of "a valid preferences document".
 */

export type ClockPreference = "12h" | "24h" | "auto";

export interface Favourites {
  /** Jolpica/Ergast `driverId`, e.g. `max_verstappen`. */
  driverId: string | null;
  /** Jolpica/Ergast `constructorId`, e.g. `red_bull`. */
  teamId: string | null;
}

/**
 * Every namespace a user can store. All optional: a document only carries
 * the keys that user has actually set, and an absent key means "use the
 * app's default", never "the user chose nothing".
 */
export interface Preferences {
  favourites?: Favourites;
  /** Owned by the customisable-home branch. Opaque here. */
  homeLayout?: unknown;
  /** Owned by the spoiler-free branch. Opaque here. */
  spoilers?: unknown;
  clock?: ClockPreference;
}

/**
 * A write. Each present key REPLACES that namespace wholesale; `null` removes
 * it. Keys that are absent are left exactly as stored.
 *
 * Namespace-level replacement rather than a deep merge, because a deep merge
 * of opaque JSON has no right answer: if the home layout drops a widget, a
 * merge would resurrect it from the stored copy. The owner of a namespace
 * always sends the whole value for it.
 */
export type PreferencesPatch = {
  [K in keyof Preferences]?: Preferences[K] | null;
};

export const PREFERENCE_KEYS = [
  "favourites",
  "homeLayout",
  "spoilers",
  "clock",
] as const satisfies readonly (keyof Preferences)[];

export const CLOCK_VALUES: readonly ClockPreference[] = ["12h", "24h", "auto"];

/**
 * Size ceilings for the opaque namespaces, in bytes of their UTF-8 JSON.
 *
 * Measured in bytes, not string length, because the limit exists to bound
 * what lands in Mongo and in every GET response, and a layout full of
 * non-ASCII labels is larger on the wire than its `.length` admits.
 *
 * 8 KB and 4 KB are generous for what they hold — a list of widget ids and
 * their order, a handful of spoiler switches — and small enough that nobody
 * can use a preferences document as free storage.
 */
export const MAX_HOME_LAYOUT_BYTES = 8 * 1024;
export const MAX_SPOILERS_BYTES = 4 * 1024;

/**
 * Ceiling on the raw request body, checked before parsing. The two opaque
 * namespaces together are 12 KB; the rest is a few dozen bytes, so 16 KB
 * leaves room for JSON whitespace without letting a client make the server
 * parse megabytes to find out it should refuse them.
 */
export const MAX_PATCH_BODY_BYTES = 16 * 1024;

/**
 * Jolpica ids are lower-case ASCII with underscores (`max_verstappen`,
 * `red_bull`, `rb`). Bounded and charset-restricted so a favourite can be
 * dropped into a URL or a query without escaping, and so the field cannot be
 * used to store anything other than an id.
 */
const ID_PATTERN = /^[a-z0-9_]{1,64}$/;

export type ValidationResult =
  | { ok: true; patch: PreferencesPatch }
  | { ok: false; error: string };

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validateId(value: unknown, field: string): string | null | Error {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    return new Error(`${field} must be a lower-case id or null`);
  }
  return value;
}

/**
 * Validate one write. Returns the normalised patch, or the first problem
 * found, phrased for a developer reading a 400 response — the UI never
 * shows these, because the UI only ever sends values it built itself.
 *
 * Unknown keys are an error rather than silently dropped. A typo such as
 * `favorites` would otherwise return 200, store nothing, and look like a
 * persistence bug on the next reload.
 */
export function validatePreferencesPatch(input: unknown): ValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: "Body must be a JSON object" };
  }

  const unknownKeys = Object.keys(input).filter(
    (key) => !(PREFERENCE_KEYS as readonly string[]).includes(key)
  );
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Unknown preference key: ${unknownKeys[0]}` };
  }

  const patch: PreferencesPatch = {};

  if ("favourites" in input) {
    const value = input.favourites;
    if (value === null) {
      patch.favourites = null;
    } else if (!isPlainObject(value)) {
      return { ok: false, error: "favourites must be an object or null" };
    } else {
      const extra = Object.keys(value).filter(
        (key) => key !== "driverId" && key !== "teamId"
      );
      if (extra.length > 0) {
        return { ok: false, error: `Unknown favourites key: ${extra[0]}` };
      }
      const driverId = validateId(value.driverId, "favourites.driverId");
      if (driverId instanceof Error) return { ok: false, error: driverId.message };
      const teamId = validateId(value.teamId, "favourites.teamId");
      if (teamId instanceof Error) return { ok: false, error: teamId.message };
      patch.favourites = { driverId, teamId };
    }
  }

  if ("clock" in input) {
    const value = input.clock;
    if (value === null) {
      patch.clock = null;
    } else if (
      typeof value !== "string" ||
      !(CLOCK_VALUES as readonly string[]).includes(value)
    ) {
      return { ok: false, error: "clock must be one of 12h, 24h, auto" };
    } else {
      patch.clock = value as ClockPreference;
    }
  }

  for (const [key, limit] of [
    ["homeLayout", MAX_HOME_LAYOUT_BYTES],
    ["spoilers", MAX_SPOILERS_BYTES],
  ] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === null) {
      patch[key] = null;
      continue;
    }
    // `undefined` cannot arrive from JSON.parse; anything else that
    // JSON.stringify accepts can be stored as-is.
    let size: number;
    try {
      size = jsonBytes(value);
    } catch {
      return { ok: false, error: `${key} must be JSON-serialisable` };
    }
    if (size > limit) {
      return {
        ok: false,
        error: `${key} is ${size} bytes; the limit is ${limit}`,
      };
    }
    patch[key] = value;
  }

  return { ok: true, patch };
}

/**
 * Apply a validated patch to a stored document, returning the new document.
 * Pure, so the client hook can compute its optimistic state with exactly the
 * rule the server uses to compute the stored one.
 */
export function applyPreferencesPatch(
  current: Preferences,
  patch: PreferencesPatch
): Preferences {
  const next: Preferences = { ...current };
  for (const key of PREFERENCE_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === undefined) {
      delete next[key];
    } else {
      // The validator has already narrowed each key to its own type.
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

/**
 * Project a stored Mongo document onto the public shape: only the known
 * namespaces, never `_id`, `userId` or timestamps. The GET handler and the
 * data export both go through this, so neither can leak a field that a
 * future write path happened to add to the document.
 */
export function pickPreferences(doc: Record<string, unknown> | null): Preferences {
  if (!doc) return {};
  const out: Preferences = {};
  for (const key of PREFERENCE_KEYS) {
    if (doc[key] !== undefined && doc[key] !== null) {
      (out as Record<string, unknown>)[key] = doc[key];
    }
  }
  return out;
}

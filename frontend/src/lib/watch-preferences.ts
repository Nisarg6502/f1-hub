/**
 * Viewer preferences and tower geometry for watch-party mode.
 *
 * Two things live here, and both are deliberately free of React and of the DOM
 * so a harness can drive them: what the viewer has chosen (pinned drivers,
 * density) and how many rows of what size the tower can actually fit.
 *
 * The geometry half exists because CP77 measured the failure it could not fix:
 * twenty rows in the ~330px a landscape phone leaves means ~15px rows and the
 * 9px font floor — nothing is clipped, but "legible across a room" stops being
 * true below about 720p. Halving the *number of rows per column* is the only
 * lever that buys real pixels back; shaving chrome buys tens of pixels, and a
 * second column buys a hundred.
 */

export type TowerDensity = "compact" | "expanded";

export const DEFAULT_DENSITY: TowerDensity = "expanded";

/* ------------------------------ persistence ------------------------------ */

/** Namespaced so nothing else in the app collides, and versioned in the value
 * shape rather than the key — a pin list is cheap to discard if it ever needs
 * to change. */
const PINNED_KEY = "apex.watch.pinnedDrivers";
const DENSITY_KEY = "apex.watch.density";

/** There is no auth in this app, so there is nowhere server-side to put "my
 * driver". `localStorage` is the whole persistence story, and it is the right
 * one here: the preference is per-device (the phone propped against the TV),
 * not per-account. Every read is guarded — this module is imported by a
 * component that renders on the server first, and Safari throws on
 * `localStorage` access in some privacy modes rather than returning null. */
function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Quota or a privacy mode. The preference still applies for this session;
    // losing it on reload is not worth interrupting a race for.
  }
}

/** Car numbers are strings everywhere in the replay payload (`"1"`, `"81"`),
 * and are kept as strings here so no `Number()` round-trip can turn `"07"`
 * into something that no longer matches a key of `replay.drivers`. */
export function loadPinnedDrivers(): string[] {
  const raw = readStorage(PINNED_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    // Hand-edited or half-written value. Treat as "nothing pinned" rather than
    // throwing inside a full-screen view with no error surface.
    return [];
  }
}

export function savePinnedDrivers(numbers: string[]): void {
  writeStorage(PINNED_KEY, JSON.stringify(numbers));
}

export function loadDensity(): TowerDensity {
  const raw = readStorage(DENSITY_KEY);
  return raw === "compact" || raw === "expanded" ? raw : DEFAULT_DENSITY;
}

export function saveDensity(density: TowerDensity): void {
  writeStorage(DENSITY_KEY, density);
}

/* ------------------------------ as a store ------------------------------ */

/**
 * `localStorage` exposed as a `useSyncExternalStore` source.
 *
 * The obvious shape — default state plus a `useEffect` that reads storage and
 * calls `setState` — is both a cascading render and, worse, the thing React
 * warns about for good reason. This is the shape the hook exists for: the
 * server snapshot is the default (so the server-rendered tree is well defined),
 * the client snapshot is what is stored, and React swaps between them at
 * hydration without a mismatch.
 *
 * Snapshots are cached because `useSyncExternalStore` compares them by
 * reference and would loop forever on a freshly-parsed array each call.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

let densityCache: TowerDensity | null = null;
let pinnedCache: string[] | null = null;

/** One module-level array, so the server snapshot is the same reference on
 * every render — `useSyncExternalStore` compares snapshots by identity and a
 * fresh `[]` each call is an infinite render loop. */
const SERVER_PINNED: string[] = [];

export function subscribePreferences(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function densitySnapshot(): TowerDensity {
  if (densityCache === null) densityCache = loadDensity();
  return densityCache;
}

export function densityServerSnapshot(): TowerDensity {
  return DEFAULT_DENSITY;
}

export function pinnedSnapshot(): string[] {
  if (pinnedCache === null) pinnedCache = loadPinnedDrivers();
  return pinnedCache;
}

export function pinnedServerSnapshot(): string[] {
  return SERVER_PINNED;
}

export function setDensityPreference(density: TowerDensity): void {
  densityCache = density;
  saveDensity(density);
  emit();
}

export function setPinnedPreference(numbers: string[]): void {
  pinnedCache = numbers;
  savePinnedDrivers(numbers);
  emit();
}

/* -------------------------------- ordering -------------------------------- */

export interface TowerSlot<T> {
  runner: T;
  /** Index in the field's real positional order — 0 is the race leader. Kept
   * separate from the visual slot so "is this the leader" and "what stripe does
   * this row get" never have to be the same question. */
  positionOrder: number;
  /** Where the row is drawn. Equal to `positionOrder` when nothing is pinned. */
  slot: number;
  pinned: boolean;
}

/**
 * Pinned drivers to the top, everyone else untouched below them.
 *
 * The ordering *semantics* are the delicate part: this is a timing tower, and a
 * tower whose rows are not in position order is normally a bug. So pinning
 * never rewrites a position — each slot keeps `positionOrder`, the row still
 * renders its real position number, and the caller draws a boundary after the
 * pinned block so an out-of-order row is explained rather than surprising.
 * Pinned drivers keep their order *relative to each other*, so two pinned
 * team-mates still read P7 above P11.
 */
export function orderRunners<T extends { number: string }>(
  runners: T[],
  pinned: ReadonlySet<string>
): TowerSlot<T>[] {
  const decorated = runners.map((runner, positionOrder) => ({
    runner,
    positionOrder,
    slot: positionOrder,
    pinned: pinned.has(runner.number),
  }));
  if (pinned.size === 0) return decorated;

  const front = decorated.filter((entry) => entry.pinned);
  const rest = decorated.filter((entry) => !entry.pinned);
  return [...front, ...rest].map((entry, slot) => ({ ...entry, slot }));
}

/* -------------------------------- geometry -------------------------------- */

export interface TowerLayoutInput {
  /** Measured content box of the tower, in CSS pixels. */
  width: number;
  height: number;
  rowCount: number;
  density: TowerDensity;
}

export interface TowerLayout {
  columns: number;
  rowsPerColumn: number;
  rowHeight: number;
  /** Row font size in px. Everything inside a row is sized in `em` off this, so
   * this single number scales a row from a phone to a television. */
  fontSize: number;
}

/** Compact trades the name column and row padding for text that is
 * proportionally larger inside a shorter row; expanded is CP77's geometry. */
const MAX_ROW_HEIGHT: Record<TowerDensity, number> = { compact: 46, expanded: 72 };
const FONT_RATIO: Record<TowerDensity, number> = { compact: 0.5, expanded: 0.42 };

/**
 * Splitting the field across columns is the compact density's whole point, so
 * expanded is pinned to one — it stays the familiar single tower with names,
 * which is exactly CP77's geometry on the desk-sized screens where that was
 * already right. Three is the ceiling because the width test below refuses the
 * third on anything phone-sized anyway; it exists for a television.
 */
const MAX_COLUMNS: Record<TowerDensity, number> = { compact: 3, expanded: 1 };

/**
 * What one compact row needs, in px, to lay out without its cells colliding.
 *
 * The coefficients are **measured, not guessed**: a real row was cloned in the
 * browser, laid out at 10px and at 20px, and its natural width came back as
 * `11.2 × font + 64` (the em-sized position, delta, code, tyre and gap cells
 * scale with the font; the flex gaps, padding and team-colour bar do not). The
 * guess this replaced was 13.5em, wrong by 25px at font 16 — which is exactly
 * the margin that decides whether a landscape phone gets a third column. The
 * flat +12 on top is headroom for a wide tyre cell (`"I 24"`) and a three-digit
 * gap, both of which are wider than the row that was measured.
 */
function requiredRowWidth(fontSize: number): number {
  return 11.2 * fontSize + 76;
}

/** A legibility backstop of last resort, for screens shorter than any of this
 * can rescue. Reached far less often now that the tower can split. */
const MIN_FONT_PX = 9;

/**
 * Row height, font size and column count for a measured tower.
 *
 * Height ceilings stop a tall desktop window from rendering six absurd rows;
 * there is deliberately **no floor** on row height, because CP77 measured what
 * a floor does — it asks for more pixels than exist and pushes P16-P20 off the
 * bottom of the screen. A whole field that is small beats most of a field that
 * is large.
 *
 * Column count is chosen by trying each candidate and keeping the one that
 * produces the **largest legible font**, rather than by a width breakpoint. A
 * landscape phone is short and wide, which is precisely the shape where spare
 * width can be traded for the height a row needs; a portrait phone has no
 * spare width and correctly gets one column. Ties go to fewer columns, so a
 * screen tall enough for full-height rows keeps the single tower.
 */
export function towerLayout({
  width,
  height,
  rowCount,
  density,
}: TowerLayoutInput): TowerLayout {
  const rows = Math.max(1, rowCount);
  const maxRow = MAX_ROW_HEIGHT[density];

  const build = (columns: number): TowerLayout => {
    const rowsPerColumn = Math.ceil(rows / columns);
    const rowHeight = Math.min(maxRow, height / rowsPerColumn);
    return {
      columns,
      rowsPerColumn,
      rowHeight,
      fontSize: Math.max(MIN_FONT_PX, rowHeight * FONT_RATIO[density]),
    };
  };

  // One column is never rejected: on a screen too narrow even for that, a
  // cramped row still beats no tower.
  let best = build(1);
  for (let columns = 2; columns <= MAX_COLUMNS[density] && columns <= rows; columns += 1) {
    const candidate = build(columns);
    if (width / columns < requiredRowWidth(candidate.fontSize)) continue;
    if (candidate.fontSize > best.fontSize) best = candidate;
  }
  return best;
}

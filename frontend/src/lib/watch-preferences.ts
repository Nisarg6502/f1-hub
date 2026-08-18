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

/**
 * Which timing column the tower emphasises: gap to the car ahead, or to the
 * leader.
 *
 * A preference rather than a layout decision because compact density has room
 * for exactly one of them, so the choice cannot be deferred to the screen.
 * Default is `"interval"`: it is the number that moves — an attacker closing
 * from 1.4s to 0.4s is the thing worth watching, whereas gap-to-leader for P14
 * changes slowly and mostly measures how long ago the race was decided.
 */
export type TimingMode = "interval" | "gap";

export const DEFAULT_TIMING_MODE: TimingMode = "interval";

/* ------------------------------ persistence ------------------------------ */

/** Namespaced so nothing else in the app collides, and versioned in the value
 * shape rather than the key — a pin list is cheap to discard if it ever needs
 * to change. */
const PINNED_KEY = "apex.watch.pinnedDrivers";
const DENSITY_KEY = "apex.watch.density";
const TIMING_MODE_KEY = "apex.watch.timingMode";

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

/** Anything that is not one of the two known modes — a hand-edited value, or a
 * mode this app used to have — falls back to the default rather than being
 * trusted into the render path. */
export function loadTimingMode(): TimingMode {
  const raw = readStorage(TIMING_MODE_KEY);
  return raw === "interval" || raw === "gap" ? raw : DEFAULT_TIMING_MODE;
}

export function saveTimingMode(mode: TimingMode): void {
  writeStorage(TIMING_MODE_KEY, mode);
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
let timingModeCache: TimingMode | null = null;
let pinnedCache: string[] | null = null;

/** One module-level array, so the server snapshot is the same reference on
 * every render — `useSyncExternalStore` compares snapshots by identity and a
 * fresh `[]` each call is an infinite render loop. */
const SERVER_PINNED: string[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

/* ------------------------------ cross-tab sync ---------------------------- */

/**
 * Watch-party mode is explicitly second-screen, so a second `/watch` tab is
 * not an edge case — but every cache above (`densityCache`, `pinnedCache`,
 * `timingModeCache`) is a module-level variable, and each tab gets its own
 * copy of this module. Nothing propagates a write in one tab to the other
 * except `localStorage` itself, which both tabs share. Without this, tab B
 * keeps rendering the value it loaded at hydration, silently diverges from
 * whatever tab A writes next, and then overwrites tab A's change the next
 * time *it* writes — the divergence this file's caches otherwise fixed
 * within a single tab reappears one level up, across tabs.
 *
 * The browser's `storage` event is the built-in fix, and it has exactly the
 * shape this needs, not the shape of the "obvious" fix rejected above:
 *
 * - It fires only in *other* same-origin tabs — never in the tab that called
 *   `localStorage.setItem`. `setDensityPreference` et al. already call
 *   `emit()` directly after writing, so there is no self-echo to guard
 *   against and no risk of a write in this tab looping back through its own
 *   listener.
 * - It fires once per `setItem`/`removeItem`/`clear()` on the *origin*, for
 *   every key — including keys this module has never heard of. `event.key`
 *   is how the handler tells "one of ours changed" from "something else on
 *   the origin changed"; a `clear()` reports `event.key === null` and is
 *   treated as "reload everything this module owns" rather than ignored.
 *
 * The handler does not read `event.newValue` itself. It drops the relevant
 * cache(s) and calls `emit()`, so the next `*Snapshot()` call goes through
 * the same `load*` functions the initial render uses — which already parse
 * defensively (a hand-edited or half-written value falls back to the
 * default rather than throwing). One code path for "read a preference from
 * storage," used whether it's the first read or a cross-tab update.
 */
function handleStorageEvent(event: StorageEvent): void {
  const { key } = event;
  let changed = false;
  if (key === null || key === PINNED_KEY) {
    pinnedCache = null;
    changed = true;
  }
  if (key === null || key === DENSITY_KEY) {
    densityCache = null;
    changed = true;
  }
  if (key === null || key === TIMING_MODE_KEY) {
    timingModeCache = null;
    changed = true;
  }
  if (changed) emit();
}

/** Attached lazily from `subscribePreferences`, not as a module-level side
 * effect at import time — this module is imported by a component that
 * renders on the server first, where `window` (and therefore
 * `addEventListener`) does not exist yet. Guarded so it attaches at most
 * once no matter how many `useSyncExternalStore` calls subscribe: density,
 * pinned drivers and timing mode already share one `listeners` set, and a
 * second `storage` listener would just invalidate the same caches and
 * `emit()` twice per event rather than catch anything the first missed.
 * Never detached — tearing it down when the last subscriber unmounts would
 * need reference counting for a listener that costs nothing to leave alive
 * for the tab's lifetime. */
let storageListenerAttached = false;

function ensureStorageListener(): void {
  if (storageListenerAttached || typeof window === "undefined") return;
  storageListenerAttached = true;
  window.addEventListener("storage", handleStorageEvent);
}

export function subscribePreferences(listener: Listener): () => void {
  ensureStorageListener();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function densitySnapshot(): TowerDensity {
  if (densityCache === null) densityCache = loadDensity();
  return densityCache;
}

export function densityServerSnapshot(): TowerDensity {
  return DEFAULT_DENSITY;
}

/** Shares `listeners`/`emit` with the other preferences on purpose. A second
 * listener set would mean a component subscribing for density silently missing
 * a timing-mode change, which is the bug this store shape exists to prevent. */
export function timingModeSnapshot(): TimingMode {
  if (timingModeCache === null) timingModeCache = loadTimingMode();
  return timingModeCache;
}

export function timingModeServerSnapshot(): TimingMode {
  return DEFAULT_TIMING_MODE;
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

export function setTimingModePreference(mode: TimingMode): void {
  timingModeCache = mode;
  saveTimingMode(mode);
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

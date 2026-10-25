/**
 * The customisable home page's layout: what widgets are on it, in what order,
 * at what size — and where that is kept.
 *
 * Deliberately free of React and the DOM, for the same reason
 * `watch-preferences.ts` is: everything here can be driven by a unit test, and
 * the grid component only ever asks this module "what is the layout" and "here
 * is the new one".
 *
 * Three layers, bottom up:
 *
 *   1. **The catalogue** — every widget type the app knows, which sizes it can
 *      be drawn at, and whether it reveals results. Pure data. The React side
 *      (`components/home/registry.tsx`) is keyed on this, so the type system
 *      refuses a widget that has metadata but no renderer or the reverse.
 *   2. **Pure layout functions** — validate a stored blob, migrate it, and the
 *      reducers the editor calls (add, remove, resize, move, reset). Every
 *      reducer returns the *same reference* when nothing changed, so a no-op
 *      never wakes `useSyncExternalStore` and never writes to storage.
 *   3. **Storage behind an interface** — `load / save / subscribe`. Today that
 *      is `localStorage`; an accounts system is coming and will put server sync
 *      behind the same three calls via `setHomeLayoutStorage`, without the grid
 *      noticing.
 */

/* -------------------------------- sizes -------------------------------- */

/**
 * Fixed sizes, not freeform resizing. This is the single decision the iOS home
 * screen's smoothness comes from: a widget snaps between a handful of shapes
 * that were each designed on purpose, so a resize is a re-layout to a known
 * good state rather than a drag through a hundred awkward intermediate ones.
 *
 * In grid cells (4 columns on desktop, 2 on phones):
 *   - `s`    1 × 1
 *   - `m`    2 × 1
 *   - `l`    2 × 2
 *   - `full` the whole row, content height. The countdown at `full` IS the
 *            hero; the strips that were already full-width on the old fixed
 *            home (race week, explore, discovery tips) use it too.
 *
 * Every span is 1 or 2, and both column counts are multiples of 2, so any mix
 * of `m` and `l` packs identically on a phone and a laptop. That is why the
 * desktop grid is 4 columns and not 3: in 3 columns two `m` widgets cannot sit
 * side by side and the layout fills with holes.
 */
export const WIDGET_SIZES = ["s", "m", "l", "full"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

const SIZE_RANK: Record<WidgetSize, number> = { s: 0, m: 1, l: 2, full: 3 };

export function isWidgetSize(value: unknown): value is WidgetSize {
  return typeof value === "string" && (WIDGET_SIZES as readonly string[]).includes(value);
}

/* ------------------------------ catalogue ------------------------------ */

export const WIDGET_TYPES = [
  "countdown",
  "race-week",
  "season",
  "leader",
  "last-race",
  "next-circuit",
  "driver-standings",
  "constructor-standings",
  "title-fight",
  "ask-pitwall",
  "tips",
  "explore",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export function isWidgetType(value: unknown): value is WidgetType {
  return typeof value === "string" && (WIDGET_TYPES as readonly string[]).includes(value);
}

export interface WidgetSpec {
  /** Sizes this widget has a design for, smallest first. */
  sizes: readonly WidgetSize[];
  /** What the gallery adds it at. Must be one of `sizes`. */
  defaultSize: WidgetSize;
  /**
   * Whether the widget can show a result someone may not have seen yet.
   *
   * A seam, not a feature: spoiler mode is being built separately and will
   * read this flag to decide what to blur. It lives here in the plain-data
   * catalogue rather than on the React registry so that logic can consult it
   * without importing a single component.
   *
   * One caveat that flag cannot express on its own: the countdown at `full`
   * size embeds the season card (its title-gap ring is a result). The
   * countdown is `false` because at every other size it shows only the
   * schedule; the embedded card is rendered by the season widget's own
   * component, so spoiler mode can gate it there.
   */
  revealsResults: boolean;
  /**
   * At most one of this widget on the page. True for everything today — two
   * championship-leader cards say nothing one does not, and the countdown's
   * `full` size carries the page's only `h1`. A future widget that makes sense
   * twice (two driver cards, say) sets this false and gets numbered ids.
   */
  unique: boolean;
}

/**
 * Adding a widget is two edits: an entry here, and an entry in
 * `components/home/registry.tsx` (which is typed `Record<WidgetType, …>`, so
 * forgetting the second is a compile error, not a blank cell).
 */
export const WIDGET_CATALOGUE: Record<WidgetType, WidgetSpec> = {
  countdown: { sizes: ["s", "m", "l", "full"], defaultSize: "full", revealsResults: false, unique: true },
  "race-week": { sizes: ["full"], defaultSize: "full", revealsResults: true, unique: true },
  season: { sizes: ["s", "m", "l"], defaultSize: "m", revealsResults: true, unique: true },
  leader: { sizes: ["s", "m"], defaultSize: "m", revealsResults: true, unique: true },
  "last-race": { sizes: ["s", "m", "l"], defaultSize: "m", revealsResults: true, unique: true },
  "next-circuit": { sizes: ["s", "m", "l"], defaultSize: "m", revealsResults: false, unique: true },
  "driver-standings": { sizes: ["s", "m", "l"], defaultSize: "m", revealsResults: true, unique: true },
  "constructor-standings": { sizes: ["s", "m", "l"], defaultSize: "m", revealsResults: true, unique: true },
  "title-fight": { sizes: ["m", "l"], defaultSize: "m", revealsResults: true, unique: true },
  "ask-pitwall": { sizes: ["s", "m"], defaultSize: "s", revealsResults: false, unique: true },
  tips: { sizes: ["m", "full"], defaultSize: "full", revealsResults: false, unique: true },
  explore: { sizes: ["l", "full"], defaultSize: "full", revealsResults: false, unique: true },
};

/**
 * The nearest size this widget supports. Ties go to the smaller one, because
 * a widget drawn a size too small still fits its cell; a size too big pushes
 * everything after it down.
 */
export function coerceSize(type: WidgetType, size: unknown): WidgetSize {
  const spec = WIDGET_CATALOGUE[type];
  if (!isWidgetSize(size)) return spec.defaultSize;
  if (spec.sizes.includes(size)) return size;
  let best = spec.sizes[0];
  for (const candidate of spec.sizes) {
    const d = Math.abs(SIZE_RANK[candidate] - SIZE_RANK[size]);
    const bestD = Math.abs(SIZE_RANK[best] - SIZE_RANK[size]);
    if (d < bestD) best = candidate;
  }
  return best;
}

/* -------------------------------- layout -------------------------------- */

export const HOME_LAYOUT_VERSION = 1;

export interface HomeLayoutItem {
  /** Stable across moves and resizes — it is the React key and the dnd-kit
   * id, so it must not change when the item does. */
  id: string;
  type: WidgetType;
  size: WidgetSize;
}

export interface HomeLayout {
  version: typeof HOME_LAYOUT_VERSION;
  items: readonly HomeLayoutItem[];
}

/**
 * The fixed home page as it was before it became customisable, expressed as a
 * layout. A visitor who never opens the editor must not be able to tell
 * anything changed, so this is the old page section for section: the hero,
 * the race-week strip, the three bento cards, the explore tiles, the tip rail.
 *
 * The bento is the one place the old page does not map exactly. It was three
 * equal cards across three columns; the grid is four columns, so the leader
 * takes `m` (the old card's design, given more width) and the other two take
 * `s`. Three equal cards would have left a hole in the fourth column.
 *
 * One module-level object, and `load()` returns this exact reference whenever
 * nothing custom is stored — so "is this visitor on the default?" is an
 * identity check, and the server snapshot is stable across renders.
 */
export const DEFAULT_HOME_LAYOUT: HomeLayout = Object.freeze({
  version: HOME_LAYOUT_VERSION,
  items: Object.freeze([
    { id: "countdown", type: "countdown", size: "full" },
    { id: "race-week", type: "race-week", size: "full" },
    { id: "leader", type: "leader", size: "m" },
    { id: "last-race", type: "last-race", size: "s" },
    { id: "next-circuit", type: "next-circuit", size: "s" },
    { id: "explore", type: "explore", size: "full" },
    { id: "tips", type: "tips", size: "full" },
  ] satisfies HomeLayoutItem[]),
}) as HomeLayout;

/** Same widgets, same order, same sizes. Ids are ignored: they are identity
 * for animation, not part of what the visitor sees. */
export function layoutsEqual(a: HomeLayout, b: HomeLayout): boolean {
  if (a === b) return true;
  if (a.items.length !== b.items.length) return false;
  return a.items.every(
    (item, i) => item.type === b.items[i].type && item.size === b.items[i].size
  );
}

export function isDefaultLayout(layout: HomeLayout): boolean {
  return layoutsEqual(layout, DEFAULT_HOME_LAYOUT);
}

/** A hand-edited blob with ten thousand entries should not get a chance to
 * render ten thousand cells. Twice the catalogue is far more than any real
 * layout can hold while every widget is unique. */
const MAX_ITEMS = WIDGET_TYPES.length * 2;

/* ------------------------------ migration ------------------------------ */

/**
 * Step functions from version N to N+1, applied in order. Empty today because
 * there has only ever been version 1 — the shape exists so the first schema
 * change is a one-line addition here and not a fork in `parseHomeLayout`.
 *
 * Each step takes the raw parsed value of version N and returns the raw value
 * of version N+1; validation runs once, on the final result, so a migration
 * never has to be defensive about fields it does not touch.
 */
export type LayoutMigration = (data: Record<string, unknown>) => Record<string, unknown>;
export const HOME_LAYOUT_MIGRATIONS: Readonly<Record<number, LayoutMigration>> = {};

function migrate(
  data: Record<string, unknown>,
  migrations: Readonly<Record<number, LayoutMigration>>
): Record<string, unknown> | null {
  let current = data;
  let version = current.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return null;
  // Written by newer code than this. We cannot know what it means, so the
  // honest move is the default — not a best guess that silently drops fields.
  if (version > HOME_LAYOUT_VERSION) return null;
  while (version < HOME_LAYOUT_VERSION) {
    const step = migrations[version];
    if (!step) return null;
    current = step(current);
    version += 1;
  }
  return current;
}

/* ------------------------------ validation ------------------------------ */

/**
 * Turn whatever was in storage into a layout that is safe to render.
 *
 * Forgiving per item and strict about the envelope: an unknown widget type is
 * dropped (a widget this build no longer ships, or one a newer tab added) and
 * an unsupported size is coerced to the nearest one that has a design, but a
 * blob that is not JSON, not an object, carries no version, or has no items
 * array falls back to the default whole. Partial trust of a corrupt envelope
 * would mean rendering half a layout nobody chose.
 *
 * Returns `DEFAULT_HOME_LAYOUT` itself (not a copy) whenever the result is
 * indistinguishable from it, so identity means "default" everywhere.
 */
export function parseHomeLayout(
  raw: string | null,
  migrations: Readonly<Record<number, LayoutMigration>> = HOME_LAYOUT_MIGRATIONS
): HomeLayout {
  if (raw === null) return DEFAULT_HOME_LAYOUT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_HOME_LAYOUT;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return DEFAULT_HOME_LAYOUT;
  }
  const migrated = migrate(parsed as Record<string, unknown>, migrations);
  if (!migrated || !Array.isArray(migrated.items)) return DEFAULT_HOME_LAYOUT;
  return normaliseLayout(migrated.items);
}

/** The per-item half of validation, also used on anything a future server
 * sync hands back. */
export function normaliseLayout(rawItems: readonly unknown[]): HomeLayout {
  const items: HomeLayoutItem[] = [];
  const seenIds = new Set<string>();
  const seenTypes = new Set<WidgetType>();

  for (const entry of rawItems.slice(0, MAX_ITEMS)) {
    if (!entry || typeof entry !== "object") continue;
    const { id, type, size } = entry as Record<string, unknown>;
    if (!isWidgetType(type)) continue;
    const spec = WIDGET_CATALOGUE[type];
    if (spec.unique && seenTypes.has(type)) continue;
    seenTypes.add(type);

    let itemId =
      typeof id === "string" && id.length > 0 && id.length <= 64 && !seenIds.has(id)
        ? id
        : null;
    if (itemId === null) itemId = nextWidgetId({ version: HOME_LAYOUT_VERSION, items }, type);
    seenIds.add(itemId);
    items.push({ id: itemId, type, size: coerceSize(type, size) });
  }

  const layout: HomeLayout = { version: HOME_LAYOUT_VERSION, items };
  return isDefaultLayout(layout) ? DEFAULT_HOME_LAYOUT : layout;
}

export function serialiseHomeLayout(layout: HomeLayout): string {
  return JSON.stringify({
    version: layout.version,
    items: layout.items.map(({ id, type, size }) => ({ id, type, size })),
  });
}

/* ------------------------------- reducers ------------------------------- */

/** Unique types use the type as their id, which keeps stored JSON readable;
 * anything else (and any collision) gets the next free numeric suffix.
 * Deterministic rather than random so tests and two tabs agree. */
export function nextWidgetId(layout: HomeLayout, type: WidgetType): string {
  const taken = new Set(layout.items.map((item) => item.id));
  if (!taken.has(type)) return type;
  let n = 2;
  while (taken.has(`${type}-${n}`)) n += 1;
  return `${type}-${n}`;
}

export function canAddWidget(layout: HomeLayout, type: WidgetType): boolean {
  return !WIDGET_CATALOGUE[type].unique || !layout.items.some((item) => item.type === type);
}

function withItems(layout: HomeLayout, items: HomeLayoutItem[]): HomeLayout {
  const next: HomeLayout = { version: HOME_LAYOUT_VERSION, items };
  return isDefaultLayout(next) ? DEFAULT_HOME_LAYOUT : next;
}

/** Appends — the end of the page is where a new widget is least disruptive,
 * and the editor scrolls it into view. Returns the layout unchanged when the
 * widget is unique and already present. */
export function addWidget(
  layout: HomeLayout,
  type: WidgetType,
  size?: WidgetSize,
  atIndex: number = layout.items.length
): HomeLayout {
  if (!isWidgetType(type) || !canAddWidget(layout, type)) return layout;
  const item: HomeLayoutItem = {
    id: nextWidgetId(layout, type),
    type,
    size: coerceSize(type, size ?? WIDGET_CATALOGUE[type].defaultSize),
  };
  const items = [...layout.items];
  items.splice(clamp(atIndex, 0, items.length), 0, item);
  return withItems(layout, items);
}

export function removeWidget(layout: HomeLayout, id: string): HomeLayout {
  const items = layout.items.filter((item) => item.id !== id);
  return items.length === layout.items.length ? layout : withItems(layout, items);
}

export function resizeWidget(layout: HomeLayout, id: string, size: WidgetSize): HomeLayout {
  const index = layout.items.findIndex((item) => item.id === id);
  if (index < 0) return layout;
  const current = layout.items[index];
  const nextSize = coerceSize(current.type, size);
  if (nextSize === current.size) return layout;
  const items = [...layout.items];
  items[index] = { ...current, size: nextSize };
  return withItems(layout, items);
}

/** Move by index, clamped to the list. Used by drag (which knows indices). */
export function moveWidget(layout: HomeLayout, from: number, to: number): HomeLayout {
  const n = layout.items.length;
  if (from < 0 || from >= n) return layout;
  const target = clamp(to, 0, n - 1);
  if (target === from) return layout;
  const items = [...layout.items];
  const [moved] = items.splice(from, 1);
  items.splice(target, 0, moved);
  return withItems(layout, items);
}

/** Move by a relative step. Used by the keyboard and the move buttons. */
export function moveWidgetBy(layout: HomeLayout, id: string, delta: number): HomeLayout {
  const from = layout.items.findIndex((item) => item.id === id);
  if (from < 0) return layout;
  return moveWidget(layout, from, from + delta);
}

export function resetHomeLayout(): HomeLayout {
  return DEFAULT_HOME_LAYOUT;
}

/** The next size up or down this widget supports, or null at either end. */
export function stepSize(type: WidgetType, size: WidgetSize, direction: 1 | -1): WidgetSize | null {
  const sizes = WIDGET_CATALOGUE[type].sizes;
  const next = sizes[sizes.indexOf(size) + direction];
  return next ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/* ------------------------------- placement ------------------------------- */

export interface Placement {
  id: string;
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
}

/**
 * Where each item lands in a grid of `columns` columns — a model of CSS grid's
 * *sparse* auto-placement, which is what the home grid uses.
 *
 * Sparse rather than `dense` on purpose: dense packing back-fills a hole with
 * a later small widget, which looks tidier but means the visual order stops
 * matching the DOM order. The DOM order is the keyboard and screen-reader
 * order, and it is the order "move earlier / move later" acts on, so a
 * widget that visibly jumped *backwards* past its neighbours when moved
 * forward would be a lie told by the layout engine. The price is that a
 * layout can leave a gap; the editor makes that visible and fixable.
 *
 * Exported so the reflow contract — one ordered list, re-placed per column
 * count, never re-ordered — is pinned by tests rather than by hoping the CSS
 * keeps behaving.
 */
export function placeLayout(items: readonly HomeLayoutItem[], columns: number): Placement[] {
  const occupied: boolean[][] = [];
  const isFree = (row: number, col: number) => !occupied[row]?.[col];
  const mark = (row: number, col: number) => {
    (occupied[row] ??= [])[col] = true;
  };
  // Sparse placement never places an item before the previous one's start.
  let cursorRow = 0;
  let cursorCol = 0;
  const placements: Placement[] = [];

  for (const item of items) {
    const columnSpan = item.size === "full" ? columns : item.size === "s" ? 1 : Math.min(2, columns);
    const rowSpan = item.size === "l" ? 2 : 1;
    let row = cursorRow;
    let col = cursorCol;
    for (;;) {
      if (col + columnSpan > columns) {
        row += 1;
        col = 0;
        continue;
      }
      let fits = true;
      for (let r = row; r < row + rowSpan && fits; r += 1) {
        for (let c = col; c < col + columnSpan; c += 1) {
          if (!isFree(r, c)) {
            fits = false;
            break;
          }
        }
      }
      if (fits) break;
      col += 1;
    }
    for (let r = row; r < row + rowSpan; r += 1) {
      for (let c = col; c < col + columnSpan; c += 1) mark(r, c);
    }
    placements.push({ id: item.id, column: col, row, columnSpan, rowSpan });
    cursorRow = row;
    cursorCol = col + columnSpan;
  }
  return placements;
}

/* ------------------------------- storage ------------------------------- */

/**
 * The seam the accounts work plugs into. Three calls, nothing else:
 *
 *   - `load()` returns a *validated* layout (never throws, never null);
 *   - `save()` persists one (fire-and-forget: a failed write keeps the layout
 *     for this session, which is the right failure for a preference);
 *   - `subscribe()` reports changes made *elsewhere* — another tab today, the
 *     server tomorrow — after which the store calls `load()` again.
 *
 * Writes made through `save()` are not echoed back through `subscribe()`; the
 * store already knows about them.
 */
export interface HomeLayoutStorage {
  load(): HomeLayout;
  save(layout: HomeLayout): void;
  subscribe(onExternalChange: () => void): () => void;
}

/** Namespaced like every other `apex.*` key. The `.v1` in the key and the
 * `version` in the value do different jobs: the key is the storage namespace
 * (a hypothetical v2 that cannot be migrated would start a new key and leave
 * the old one readable for migration), the value's version drives
 * `HOME_LAYOUT_MIGRATIONS`. */
export const HOME_LAYOUT_KEY = "apex.home.v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StorageEventSource {
  addEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
  removeEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
}

/**
 * The `localStorage` implementation. Both the storage and the event source
 * are injectable so tests drive it without a DOM; in the browser they default
 * to `window.localStorage` and `window`.
 *
 * Every access is guarded: this module is imported by a component that
 * renders on the server first, and Safari throws on `localStorage` in some
 * privacy modes rather than returning null.
 *
 * Saving the default *removes* the key rather than writing it. "Reset to
 * default" then means what it says — the visitor is back on the default, and
 * if the default itself changes in a later release, they get the new one
 * instead of a frozen copy of the old.
 */
export function createLocalHomeLayoutStorage({
  key = HOME_LAYOUT_KEY,
  getStorage = defaultStorage,
  events = defaultEventSource(),
}: {
  key?: string;
  getStorage?: () => StorageLike | null;
  events?: StorageEventSource | null;
} = {}): HomeLayoutStorage {
  return {
    load() {
      try {
        return parseHomeLayout(getStorage()?.getItem(key) ?? null);
      } catch {
        return DEFAULT_HOME_LAYOUT;
      }
    },
    save(layout) {
      try {
        const storage = getStorage();
        if (!storage) return;
        if (isDefaultLayout(layout)) storage.removeItem(key);
        else storage.setItem(key, serialiseHomeLayout(layout));
      } catch {
        // Quota or a privacy mode: the layout still applies until reload.
      }
    },
    subscribe(onExternalChange) {
      if (!events) return () => {};
      // `storage` fires only in *other* tabs, so there is no self-echo to
      // filter; `key === null` is a `clear()` and is treated as ours.
      const handler = (event: { key: string | null }) => {
        if (event.key === null || event.key === key) onExternalChange();
      };
      events.addEventListener("storage", handler);
      return () => events.removeEventListener("storage", handler);
    },
  };
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function defaultEventSource(): StorageEventSource | null {
  return typeof window === "undefined" ? null : (window as unknown as StorageEventSource);
}

/* -------------------------------- store -------------------------------- */

/**
 * The active storage exposed as a `useSyncExternalStore` source, in the shape
 * `watch-preferences.ts` established: the server snapshot is the default
 * layout, so the server-rendered tree is exactly the default home; the client
 * snapshot is whatever is stored, and React swaps between them after
 * hydration without a mismatch. (How the grid makes that swap calm is
 * documented in `components/home/home-grid.tsx`.)
 *
 * The snapshot is cached because `useSyncExternalStore` compares by identity
 * and would loop forever on a freshly parsed object per call.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let activeStorage: HomeLayoutStorage | null = null;
let detachStorage: (() => void) | null = null;
let cache: HomeLayout | null = null;

function storage(): HomeLayoutStorage {
  activeStorage ??= createLocalHomeLayoutStorage();
  return activeStorage;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function attach(): void {
  if (detachStorage) return;
  detachStorage = storage().subscribe(() => {
    cache = null;
    emit();
  });
}

/** Swap the persistence backend (the accounts seam). Drops the cache and
 * re-subscribes, so the grid re-renders from the new source immediately. */
export function setHomeLayoutStorage(next: HomeLayoutStorage): void {
  detachStorage?.();
  detachStorage = null;
  activeStorage = next;
  cache = null;
  if (listeners.size > 0) attach();
  emit();
}

export function subscribeHomeLayout(listener: Listener): () => void {
  attach();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function homeLayoutSnapshot(): HomeLayout {
  cache ??= storage().load();
  return cache;
}

export function homeLayoutServerSnapshot(): HomeLayout {
  return DEFAULT_HOME_LAYOUT;
}

/** Apply a new layout: in memory first (so the UI never waits on storage),
 * then persisted, then announced. A no-op layout is ignored entirely. */
export function commitHomeLayout(next: HomeLayout): void {
  const current = homeLayoutSnapshot();
  if (next === current) return;
  cache = isDefaultLayout(next) ? DEFAULT_HOME_LAYOUT : next;
  storage().save(cache);
  emit();
}

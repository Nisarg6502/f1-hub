/**
 * Share cards: the contract between the image routes (`app/api/share/**`), the
 * share sheet (`components/share/**`) and the analytics event.
 *
 * Kept free of React, of the DOM and of `next/*` for the same reason
 * `analytics.ts` is: every decision in here is a pure function of its
 * arguments, so `vitest` drives it in node with no jsdom (see
 * `vitest.config.ts`).
 *
 * Three groups live here:
 *
 *   - **Formats and surfaces** — the two canvas sizes every card is drawn at,
 *     and the four places a card can come from.
 *   - **Parameter parsing** — the routes accept user-editable URLs, so every
 *     parameter is validated here into either a typed value or a reason. A
 *     malformed URL is the *caller's* mistake and must answer 400; letting
 *     `Number("abc")` reach the backend turned it into an upstream error,
 *     which the route would then have reported as a 5xx it did not deserve.
 *   - **Sheet decisions** — which actions a browser actually supports, what
 *     the downloaded file is called, and the analytics payload.
 */

/** The oldest season the backend serves. Mirrors `MIN_SUPPORTED_SEASON` in `api.ts`. */
export const MIN_SHARE_SEASON = 2018;

/**
 * The two canvases.
 *
 * Landscape is the Open Graph size, so the same URL can be a link preview.
 * Portrait is 4:5, the tallest ratio Instagram's feed shows uncropped and the
 * one that fills a phone screen in a chat thread without letterboxing.
 */
export const SHARE_FORMATS = {
  landscape: { width: 1200, height: 630 },
  portrait: { width: 1080, height: 1350 },
} as const;

export type ShareFormat = keyof typeof SHARE_FORMATS;

export const SHARE_FORMAT_LABELS: Record<ShareFormat, string> = {
  landscape: "Landscape",
  portrait: "Portrait",
};

/** Where a card was shared from. Enum-ish on purpose: it is an analytics value. */
export type ShareSurface = "standings" | "race" | "progression" | "answer";

/** What the reader did with it. Also an analytics value. */
export type ShareAction = "share" | "download" | "copy_image" | "copy_link";

export type StandingsKind = "drivers" | "constructors";
export type RaceSession = "race" | "sprint";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The subset of `URLSearchParams` the parsers read, so a plain map satisfies it in tests. */
export interface ParamSource {
  get(name: string): string | null;
}

/**
 * A missing format means landscape; an unrecognised one is an error.
 *
 * Missing defaults rather than failing because the bare URL is the link
 * preview, and a crawler fetching `og:image` will never add `?format=`.
 * Unrecognised fails rather than defaulting because `?format=square` silently
 * returning a landscape image is a bug report waiting to be filed.
 */
export function parseShareFormat(raw: string | null | undefined): ParseResult<ShareFormat> {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: "landscape" };
  if (raw === "landscape" || raw === "portrait") return { ok: true, value: raw };
  return { ok: false, error: `format must be "landscape" or "portrait"` };
}

/**
 * A season as a strict four-digit integer inside the served range.
 *
 * Strict on purpose — `Number(" 2026")`, `Number("2026.0")` and `Number("0x7EA")`
 * are all 2026, and accepting them would mean one card answering to many URLs,
 * which defeats the point of a cacheable address.
 *
 * Out-of-range is an error here, where `resolveSeasonYear` clamps. The page
 * clamps because a reader typing `?season=2050` should still see a page; an
 * image URL that silently answers with a different season than it names is a
 * lie baked into a PNG.
 */
export function parseSeason(
  raw: string | null | undefined,
  activeSeason: number,
  { required }: { required: boolean }
): ParseResult<number> {
  if (raw === null || raw === undefined || raw === "") {
    return required
      ? { ok: false, error: "season is required" }
      : { ok: true, value: activeSeason };
  }
  if (!/^\d{4}$/.test(raw)) return { ok: false, error: "season must be a four-digit year" };
  const year = Number(raw);
  if (year < MIN_SHARE_SEASON || year > activeSeason) {
    return {
      ok: false,
      error: `season must be between ${MIN_SHARE_SEASON} and ${activeSeason}`,
    };
  }
  return { ok: true, value: year };
}

/** No calendar has had more than 24 rounds; 30 leaves room without accepting nonsense. */
export const MAX_SHARE_ROUND = 30;

export function parseRound(raw: string | null | undefined): ParseResult<number> {
  if (!raw || !/^\d{1,2}$/.test(raw)) return { ok: false, error: "round must be a number" };
  const round = Number(raw);
  if (round < 1 || round > MAX_SHARE_ROUND) {
    return { ok: false, error: `round must be between 1 and ${MAX_SHARE_ROUND}` };
  }
  return { ok: true, value: round };
}

export function parseStandingsKind(raw: string | null | undefined): ParseResult<StandingsKind> {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: "drivers" };
  if (raw === "drivers" || raw === "constructors") return { ok: true, value: raw };
  return { ok: false, error: `kind must be "drivers" or "constructors"` };
}

export function parseRaceSession(raw: string | null | undefined): ParseResult<RaceSession> {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: "race" };
  if (raw === "race" || raw === "sprint") return { ok: true, value: raw };
  return { ok: false, error: `session must be "race" or "sprint"` };
}

export interface StandingsCardParams {
  season: number;
  kind: StandingsKind;
  format: ShareFormat;
}

/**
 * `?season=&kind=&format=` for both `/api/share/standings` and
 * `/api/share/progression` — they address the same thing (one championship,
 * one season) drawn two ways.
 */
export function parseStandingsParams(
  params: ParamSource,
  activeSeason: number
): ParseResult<StandingsCardParams> {
  const season = parseSeason(params.get("season"), activeSeason, { required: false });
  if (!season.ok) return season;
  const kind = parseStandingsKind(params.get("kind"));
  if (!kind.ok) return kind;
  const format = parseShareFormat(params.get("format"));
  if (!format.ok) return format;
  return { ok: true, value: { season: season.value, kind: kind.value, format: format.value } };
}

export interface RaceCardParams {
  season: number;
  round: number;
  session: RaceSession;
  format: ShareFormat;
}

/** `/api/share/race/[season]/[round]?session=&format=`. */
export function parseRaceParams(
  segments: { season: string; round: string },
  params: ParamSource,
  activeSeason: number
): ParseResult<RaceCardParams> {
  const season = parseSeason(segments.season, activeSeason, { required: true });
  if (!season.ok) return season;
  const round = parseRound(segments.round);
  if (!round.ok) return round;
  const session = parseRaceSession(params.get("session"));
  if (!session.ok) return session;
  const format = parseShareFormat(params.get("format"));
  if (!format.ok) return format;
  return {
    ok: true,
    value: {
      season: season.value,
      round: round.value,
      session: session.value,
      format: format.value,
    },
  };
}

/* ==========================================================================
   URLs — built in one place so the sheet, the tests and the routes agree.
   ========================================================================== */

export function standingsCardPath(p: StandingsCardParams): string {
  return `/api/share/standings?season=${p.season}&kind=${p.kind}&format=${p.format}`;
}

export function progressionCardPath(p: StandingsCardParams): string {
  return `/api/share/progression?season=${p.season}&kind=${p.kind}&format=${p.format}`;
}

export function raceCardPath(p: RaceCardParams): string {
  const session = p.session === "sprint" ? "session=sprint&" : "";
  return `/api/share/race/${p.season}/${p.round}?${session}format=${p.format}`;
}

/**
 * `Cache-Control` for a card.
 *
 * A past season's standings and a past race's result do not change, so they
 * can be cached for a day at the edge and by the browser. The active season
 * changes after every session, and this project's sync already lags timing by
 * up to an hour (see /data-sources) — a card that adds another long cache on
 * top of that would be shared minutes after a race still showing the round
 * before. Five minutes matches `fetchJson`'s own revalidate window, so the
 * image is never staler than the page it was shared from.
 */
export function shareCacheControl(season: number, activeSeason: number): string {
  return season < activeSeason
    ? "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800"
    : "public, max-age=300, s-maxage=300, stale-while-revalidate=3600";
}

/* ==========================================================================
   Filenames
   ========================================================================== */

/**
 * Lowercase ASCII words joined by hyphens: `"São Paulo Grand Prix"` →
 * `"sao-paulo-grand-prix"`.
 *
 * Diacritics are folded rather than dropped (so it is not `"so-paulo"`), and
 * anything else that is not a letter or digit becomes a separator. A filename
 * is the one place a non-ASCII character is still a real risk — Windows'
 * reserved characters, a messaging app that mangles UTF-8 attachment names.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/**
 * `apex-<parts…>-<format>.png`, with empty parts skipped.
 *
 * The format is in the name because a reader who downloads both will
 * otherwise get `apex-standings-2026 (1).png` and have to open each to tell
 * them apart.
 */
export function shareFilename(parts: Array<string | number | null | undefined>, format: ShareFormat): string {
  const slug = parts
    .map((part) => (part === null || part === undefined ? "" : slugify(String(part))))
    .filter(Boolean)
    .join("-");
  return `apex-${slug ? `${slug}-` : ""}${format}.png`;
}

/* ==========================================================================
   Sheet actions
   ========================================================================== */

/** What a browser was found to support. Each is a feature test, never a UA sniff. */
export interface ShareCapabilities {
  /** `navigator.canShare({ files: [png] })` returned true for the actual file. */
  canShareFiles: boolean;
  /** `ClipboardItem` exists and `navigator.clipboard.write` is a function. */
  canCopyImage: boolean;
  /** `navigator.clipboard.writeText` is a function. */
  canCopyText: boolean;
}

/**
 * The actions to offer, in the order to show them.
 *
 * Unsupported actions are absent rather than disabled. A greyed-out "Share"
 * on a desktop browser that will never support it is a control the reader
 * cannot use and cannot learn to use; it only advertises a missing feature.
 *
 * Download is unconditional: an `<a download>` on a blob URL works everywhere
 * this app runs, and it is the floor every other action falls back to.
 */
export function availableShareActions(
  caps: ShareCapabilities,
  { hasLink }: { hasLink: boolean }
): ShareAction[] {
  const actions: ShareAction[] = [];
  if (caps.canShareFiles) actions.push("share");
  actions.push("download");
  if (caps.canCopyImage) actions.push("copy_image");
  if (hasLink && caps.canCopyText) actions.push("copy_link");
  return actions;
}

/**
 * The analytics payload for one share.
 *
 * Surface and action only — never the season, the driver, the question or a
 * word of the answer. `track()`'s contract is enum-ish values only, and an
 * answer card's content is text a reader typed.
 */
export function shareEventParams(
  surface: ShareSurface,
  action: ShareAction
): { surface: ShareSurface; action: ShareAction } {
  return { surface, action };
}

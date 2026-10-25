/**
 * Spoiler-free mode: the rules, and nothing else.
 *
 * Many people watch a race hours or days after it runs. With the mode on, a
 * round's results are kept off the screen from the moment its first
 * result-producing session starts until the visitor says they have watched it.
 *
 * ## The API, for anyone wiring a new surface
 *
 *   lib/spoilers.ts            (this file; pure, importable anywhere)
 *     parseSpoilerCookie / serializeSpoilerPrefs     the cookie format
 *     isRoundHidden(prefs, raceKey, firstSessionStartMs, nowMs, raceStartMs?)
 *     hiddenRounds(races, prefs, nowMs, season?)     -> HiddenRound[]
 *     raceKey(season, round), findHiddenRound, redactWinners, describeRounds
 *
 *   lib/spoilers-server.ts     (server components only; reads `cookies()`)
 *     getSpoilerPrefs()                    -> SpoilerPrefs
 *     getSpoilerContext(season, {races?})  -> { prefs, hidden, round(n) }
 *
 *   lib/spoilers-client.ts     (client components only)
 *     useSpoilers() -> { prefs, ready, pending, reveal, revealMany, setOn,
 *                        setAutoRevealDays }
 *
 *   components/spoiler-shield.tsx
 *     <SpoilerShield hidden raceKey raceName>{children}</SpoilerShield>
 *     <SpoilerBanner .../>  and  <SpoilerStub/>  for the smaller footprints
 *
 * Wiring a server-rendered surface is a few lines:
 *
 *   const spoilers = await getSpoilerContext(season, { races });
 *   const hidden = spoilers.round(round);
 *   <SpoilerShield hidden={!!hidden} raceKey={hidden?.raceKey ?? ""}
 *     raceName={hidden?.raceName ?? ""}>...</SpoilerShield>
 *
 * Anything that depends on the *season so far* (standings, a leader card, a
 * title-gap ring) is hidden while `spoilers.hidden.length > 0`, because every
 * one of those numbers moved when the hidden round was scored.
 *
 * ## Why a cookie and not localStorage
 *
 * Most result surfaces are server components. If the preference lived in
 * localStorage the server would render the podium, ship it, and a client
 * effect would hide it a frame later: a spoiler on first paint, which is the
 * one thing this feature exists to prevent. A cookie reaches the server with
 * the request, so a hidden result is never rendered at all.
 *
 * "Never rendered" is a statement about pixels, not bytes. Server components
 * that skip rendering a subtree do not serialise it either, and the pages here
 * skip fetching what they will not show, but a determined reader with
 * view-source or the network panel can still find data elsewhere (the season
 * calendar, an API response). This protects eyes, not the wire.
 *
 * ## Cookie format
 *
 *   v1|<on 0/1>|<auto-reveal days: 3, 7 or 0 for never>|<since, base-36 minutes>|<keys>
 *
 * e.g. `v1|1|7|2qkbz4|2026-21.2026-20`. Every character is a legal
 * cookie-octet (RFC 6265 forbids comma, semicolon, quote, backslash and
 * whitespace, which rules out raw JSON), so the value round-trips through
 * `document.cookie` and Next's `cookies()` with no encoding step for either
 * side to get wrong. Thirty keys is about 240 bytes.
 */

import type { Race } from "./api";

export const SPOILER_COOKIE = "apex_spoilers";

/** How many revealed rounds are remembered. Newest kept, oldest dropped. */
export const MAX_REVEALED = 30;

/**
 * The browser caps a cookie's lifetime at 400 days (Chrome since M104), so
 * asking for longer only yields a cookie whose expiry is quietly rewritten.
 * Every write refreshes it, so an active visitor never loses the setting.
 */
export const SPOILER_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far before the moment the mode was switched on a round can still be
 * hidden.
 *
 * Without a floor, "never auto-reveal" means every result since 1950 is hidden
 * and the history page is a wall of placeholders, which nobody turning the
 * mode on is asking for. With a floor of zero, the most common way people
 * arrive here (they missed Sunday's race and switch the mode on on Monday
 * morning) would hide nothing. A week covers that, and matches the default
 * auto-reveal so the two settings agree about what "recent" means.
 */
export const ENABLE_LOOKBACK_MS = 7 * DAY_MS;

export type AutoRevealDays = 3 | 7 | null;

/** The choices the settings panel offers, in display order. */
export const AUTO_REVEAL_CHOICES: ReadonlyArray<{
  value: AutoRevealDays;
  label: string;
}> = [
  { value: 3, label: "After 3 days" },
  { value: 7, label: "After 7 days" },
  { value: null, label: "Never" },
];

export interface SpoilerPrefs {
  on: boolean;
  /** Days after the grand prix starts that its round reveals itself. Null = never. */
  autoRevealDays: AutoRevealDays;
  /** Race keys the visitor has revealed, newest first, at most `MAX_REVEALED`. */
  revealed: string[];
  /**
   * When the mode was last switched on, epoch ms (minute precision), or 0 when
   * unknown. See `ENABLE_LOOKBACK_MS`.
   */
  since: number;
}

export const DEFAULT_SPOILER_PREFS: SpoilerPrefs = Object.freeze({
  on: false,
  autoRevealDays: 7,
  revealed: [],
  since: 0,
}) as SpoilerPrefs;

/**
 * What an unreadable cookie means: ON, with the default auto-reveal.
 *
 * Fails closed, deliberately. Nobody has an `apex_spoilers` cookie unless they
 * used this feature, so a value that will not parse almost certainly belonged
 * to someone protecting themselves, and guessing "off" would show them the
 * result they were hiding. The cost of guessing wrong the other way is a
 * placeholder and one click on the eye control, which rewrites the cookie.
 * `since` stays 0 so the seven-day auto-reveal is the only bound.
 */
export const CORRUPT_SPOILER_PREFS: SpoilerPrefs = Object.freeze({
  on: true,
  autoRevealDays: 7,
  revealed: [],
  since: 0,
}) as SpoilerPrefs;

const RACE_KEY_RE = /^\d{4}-\d{1,2}$/;

/** `2026-21`. Normalises `"07"` to `7` so a padded round never misses. */
export function raceKey(season: string | number, round: string | number): string {
  return `${Number(season)}-${Number(round)}`;
}

export function isRaceKey(value: string): boolean {
  return RACE_KEY_RE.test(value);
}

function parseDays(raw: string): AutoRevealDays {
  if (raw === "3") return 3;
  if (raw === "0") return null;
  // "7", and anything unrecognised: the default is the safe middle.
  return 7;
}

function uniqueKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    if (!isRaceKey(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length === MAX_REVEALED) break;
  }
  return out;
}

/**
 * Read the cookie value (not the whole `Cookie` header).
 *
 * Absent or empty is "never used the feature": off. Structurally broken is
 * `CORRUPT_SPOILER_PREFS` (see there for why that is ON). Damage confined to
 * one field is repaired in place rather than throwing the rest away: a bad
 * auto-reveal reads as 7, a bad `since` as 0, and malformed keys are dropped.
 */
export function parseSpoilerCookie(raw: string | null | undefined): SpoilerPrefs {
  if (raw === null || raw === undefined || raw === "") {
    return { ...DEFAULT_SPOILER_PREFS, revealed: [] };
  }

  let value = raw;
  try {
    // Something along the way (a proxy, a browser extension, a future server
    // write through Next's serializer) may percent-encode the separators.
    value = decodeURIComponent(raw);
  } catch {
    return { ...CORRUPT_SPOILER_PREFS, revealed: [] };
  }

  const parts = value.split("|");
  if (parts.length !== 5 || parts[0] !== "v1") {
    return { ...CORRUPT_SPOILER_PREFS, revealed: [] };
  }
  const [, onRaw, daysRaw, sinceRaw, keysRaw] = parts;
  if (onRaw !== "0" && onRaw !== "1") {
    return { ...CORRUPT_SPOILER_PREFS, revealed: [] };
  }

  const sinceMinutes = /^[0-9a-z]{1,10}$/.test(sinceRaw) ? parseInt(sinceRaw, 36) : NaN;
  const since = Number.isFinite(sinceMinutes) ? sinceMinutes * 60_000 : 0;

  return {
    on: onRaw === "1",
    autoRevealDays: parseDays(daysRaw),
    revealed: uniqueKeys(keysRaw === "" ? [] : keysRaw.split(".")),
    since,
  };
}

export function serializeSpoilerPrefs(prefs: SpoilerPrefs): string {
  const days = prefs.autoRevealDays === null ? "0" : String(prefs.autoRevealDays);
  const since = Math.max(0, Math.floor((prefs.since || 0) / 60_000)).toString(36);
  return [
    "v1",
    prefs.on ? "1" : "0",
    days,
    since,
    uniqueKeys(prefs.revealed).join("."),
  ].join("|");
}

/** Mark one or more rounds watched. Newest first, capped, deduplicated. */
export function withRevealed(prefs: SpoilerPrefs, keys: string | string[]): SpoilerPrefs {
  const incoming = (Array.isArray(keys) ? keys : [keys]).filter(isRaceKey);
  return {
    ...prefs,
    revealed: uniqueKeys([...incoming, ...prefs.revealed]),
  };
}

/**
 * Switch the mode. Turning it on stamps `since` (see `ENABLE_LOOKBACK_MS`);
 * turning it off keeps the revealed list, so off-then-on again does not
 * re-hide a round the visitor already said they had watched.
 */
export function withOn(prefs: SpoilerPrefs, on: boolean, nowMs: number): SpoilerPrefs {
  if (!on) return { ...prefs, on: false };
  const since = prefs.on && prefs.since > 0 ? prefs.since : nowMs;
  return { ...prefs, on: true, since };
}

export function withAutoRevealDays(
  prefs: SpoilerPrefs,
  days: AutoRevealDays,
  nowMs: number
): SpoilerPrefs {
  // A cookie that failed to parse has `since` 0, and choosing "never" on top
  // of that would remove the only bound on how far back a round can hide.
  const since = prefs.on && prefs.since === 0 ? nowMs : prefs.since;
  return { ...prefs, autoRevealDays: days, since };
}

// --- Timing -----------------------------------------------------------------

/**
 * Sessions whose outcome is a result in the spoiler sense: a grid, a sprint
 * classification, a race classification.
 *
 * Practice is deliberately absent. Practice times are not what anyone means by
 * "don't tell me what happened", and hiding a round from FP1 would blank the
 * whole weekend page for three days before a single result exists.
 */
const RESULT_SESSION_FIELDS = ["SprintQualifying", "Sprint", "Qualifying"] as const;

/**
 * A session start in epoch ms. A missing time is read as MIDNIGHT UTC, not the
 * noon `lib/sessions.ts` assumes for display: for hiding, erring early is the
 * safe direction, and a schedule row without a time is usually one where the
 * start has not been published yet anyway.
 */
function sessionStartMs(date?: string, time?: string, missingTime = "00:00:00Z"): number | null {
  if (!date) return null;
  const t = time ?? missingTime;
  const iso = t.endsWith("Z") ? `${date}T${t}` : `${date}T${t}Z`;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** When the round's first result-producing session starts. Null when unscheduled. */
export function firstResultSessionMs(race: Race): number | null {
  const starts: number[] = [];
  for (const field of RESULT_SESSION_FIELDS) {
    const ms = sessionStartMs(race[field]?.date, race[field]?.time);
    if (ms !== null) starts.push(ms);
  }
  const raceMs = sessionStartMs(race.date, race.time);
  if (raceMs !== null) starts.push(raceMs);
  return starts.length ? Math.min(...starts) : null;
}

/** When the grand prix itself starts; auto-reveal counts from here. */
export function raceStartMs(race: Race): number | null {
  return sessionStartMs(race.date, race.time, "12:00:00Z");
}

/**
 * Whether one round's results are hidden right now.
 *
 * @param firstSessionStartMs  the round's first result-producing session
 *   (`firstResultSessionMs`). Hidden from this instant, inclusive.
 * @param raceStartMs  where the auto-reveal clock starts; the grand prix
 *   itself. Defaults to the first session for callers that only know that.
 *   Counting from Friday's sprint qualifying would make "3 days" mean Monday
 *   morning on a sprint weekend, barely a day after the race.
 */
export function isRoundHidden(
  prefs: SpoilerPrefs,
  key: string,
  firstSessionStartMs: number | null | undefined,
  nowMs: number,
  raceStartMs?: number | null
): boolean {
  if (!prefs.on) return false;
  if (firstSessionStartMs === null || firstSessionStartMs === undefined) return false;
  if (!Number.isFinite(firstSessionStartMs)) return false;
  if (nowMs < firstSessionStartMs) return false;
  if (prefs.revealed.includes(key)) return false;
  if (prefs.since > 0 && firstSessionStartMs < prefs.since - ENABLE_LOOKBACK_MS) return false;
  if (prefs.autoRevealDays !== null) {
    const from = Math.max(raceStartMs ?? firstSessionStartMs, firstSessionStartMs);
    if (nowMs >= from + prefs.autoRevealDays * DAY_MS) return false;
  }
  return true;
}

export interface HiddenRound {
  raceKey: string;
  season: number;
  round: number;
  raceName: string;
  /** "Mexico City GP", for tight spaces. */
  shortName: string;
  firstResultMs: number;
}

export function shortRaceName(raceName: string): string {
  return raceName.replace(/ Grand Prix$/, " GP");
}

/**
 * Every round of `races` that is hidden at `nowMs`, in round order.
 *
 * @param season  used when a race document has no `season` of its own.
 */
export function hiddenRounds(
  races: Race[],
  prefs: SpoilerPrefs,
  nowMs: number,
  season?: number
): HiddenRound[] {
  if (!prefs.on) return [];
  const out: HiddenRound[] = [];
  for (const race of races) {
    const seasonNum = Number(race.season ?? season);
    const roundNum = Number(race.round);
    if (!Number.isFinite(seasonNum) || !Number.isFinite(roundNum)) continue;
    const key = raceKey(seasonNum, roundNum);
    const first = firstResultSessionMs(race);
    if (!isRoundHidden(prefs, key, first, nowMs, raceStartMs(race))) continue;
    out.push({
      raceKey: key,
      season: seasonNum,
      round: roundNum,
      raceName: race.raceName,
      shortName: shortRaceName(race.raceName),
      firstResultMs: first as number,
    });
  }
  return out.sort((a, b) => a.season - b.season || a.round - b.round);
}

/**
 * Which seasons can contain a hidden round right now: usually just the active
 * one, the previous one as well across New Year. Bounded by the same floor
 * the rules use (`ENABLE_LOOKBACK_MS`, or the auto-reveal window when `since`
 * is unknown), and never more than two, so listing hidden rounds can never
 * turn into fetching a decade of calendars.
 */
export function seasonsInWindow(
  prefs: SpoilerPrefs,
  nowMs: number,
  activeSeason: number
): number[] {
  if (!prefs.on) return [];
  const floor =
    prefs.since > 0
      ? prefs.since - ENABLE_LOOKBACK_MS
      : nowMs - ((prefs.autoRevealDays ?? 7) + 7) * DAY_MS;
  const first = Math.max(activeSeason - 1, Math.min(activeSeason, new Date(floor).getUTCFullYear()));
  const out: number[] = [];
  for (let year = first; year <= activeSeason; year++) out.push(year);
  return out;
}

export function findHiddenRound(
  hidden: HiddenRound[],
  season: string | number,
  round: string | number
): HiddenRound | null {
  const key = raceKey(season, round);
  return hidden.find((h) => h.raceKey === key) ?? null;
}

/**
 * The season calendar with `winner` removed from hidden rounds.
 *
 * `/api/races` attaches each round's winner, and the calendar is passed whole
 * to client components (the race selector, the schedule board), so a winner
 * left on the object is serialised into the page even where nothing draws it.
 */
export function redactWinners<T extends Race>(races: T[], hidden: HiddenRound[]): T[] {
  if (hidden.length === 0) return races;
  return races.map((race) => {
    const seasonNum = Number(race.season);
    const isHidden = hidden.some(
      (h) =>
        h.round === Number(race.round) &&
        (!Number.isFinite(seasonNum) || h.season === seasonNum)
    );
    if (!isHidden || !race.winner) return race;
    const copy = { ...race };
    delete copy.winner;
    return copy;
  });
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "the Mexico City Grand Prix", "the Mexico City and São Paulo Grand Prix results". */
export function describeRounds(names: string[]): string {
  const list = joinNames(names);
  return list ? `the ${list}` : "";
}

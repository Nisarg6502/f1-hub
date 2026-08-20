import type { ConstructorTitlesResponse } from "./constructor-profiles";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

type SearchParams = Record<string, string | number | boolean | undefined>;

async function fetchJson<T>(
  path: string,
  params?: SearchParams,
  options?: RequestInit
): Promise<T> {
  const url = new URL(path, API_BASE_URL);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined) return;
      url.searchParams.set(key, String(value));
    });
  }

  const res = await fetch(url.toString(), {
    next: { revalidate: 300 }, // Default revalidation: 5 minutes (300 seconds)
    ...options,
  });

  if (!res.ok) {
    throw new Error(`API error ${res.status} for ${url.toString()}`);
  }

  return (await res.json()) as T;
}

// --- Types ---

export interface Race {
  raceName: string;
  round: string;
  season?: string;
  date: string;
  time?: string;
  url?: string;
  Circuit?: {
    circuitId?: string;
    circuitName?: string;
    url?: string;
    Location?: {
      locality?: string;
      country?: string;
    };
  };
  FirstPractice?: { date?: string; time?: string };
  SecondPractice?: { date?: string; time?: string };
  ThirdPractice?: { date?: string; time?: string };
  Sprint?: { date?: string; time?: string };
  SprintQualifying?: { date?: string; time?: string };
  Qualifying?: { date?: string; time?: string };
  /** Attached server-side once the round's results are cached; absent otherwise. */
  winner?: {
    givenName: string;
    familyName: string;
    code: string;
  };
}

export interface DriverStanding {
  position: string;
  points: string;
  wins: string;
  Driver: {
    driverId?: string;
    givenName?: string;
    familyName?: string;
    code?: string;
    nationality?: string;
    permanentNumber?: string;
  };
  Constructors?: Array<{
    constructorId?: string;
    name?: string;
    nationality?: string;
  }>;
}

export interface ConstructorStanding {
  position: string;
  points: string;
  wins: string;
  Constructor: {
    constructorId?: string;
    name?: string;
    nationality?: string;
  };
}

export interface RaceResult {
  number?: string;
  position?: string;
  positionText?: string;
  points?: string;
  grid?: string;
  laps?: string;
  status?: string;
  Driver?: {
    driverId?: string;
    givenName?: string;
    familyName?: string;
    code?: string;
    nationality?: string;
    permanentNumber?: string;
  };
  Constructor?: {
    constructorId?: string;
    name?: string;
    nationality?: string;
  };
  Time?: {
    millis?: string;
    time?: string;
  };
  FastestLap?: {
    rank?: string;
    lap?: string;
    Time?: { time?: string };
    AverageSpeed?: { speed?: string; units?: string };
  };
  Q1?: string;
  Q2?: string;
  Q3?: string;
}

export interface CircuitInfo {
  year: number;
  event_name: string;
  country: string | null;
  city: string | null;
  total_laps: number | null;
  num_corners: number;
  fastest_lap: {
    time: string | null;
    driver: string | null;
    year: number | null;
  };
}

export interface LiveTimingSector {
  Completed?: boolean;
  OverallFastest?: boolean;
  PersonalFastest?: boolean;
  PreviousValue?: string;
  Status?: number;
  Stopped?: boolean;
  Value?: string;
}

export interface LiveTimingLine {
  Sectors?: LiveTimingSector[];
  bestLapTime?: string;
  compound?: string;
  driver?: {
    BroadcastName?: string;
    FullName?: string;
    RacingNumber?: string;
    TeamColour?: string;
    TeamName?: string;
    Tla?: string;
  };
  drs?: string;
  gapToLeader?: string;
  inPit?: boolean;
  intervalToPositionAhead?: string;
  lastLapTime?: string;
  position?: string;
  racingNumber?: string;
  retired?: boolean;
  stopped?: boolean;
  timeDiffToFastest?: string;
  timeDiffToPositionAhead?: string;
  tyreAge?: number;
}

export interface LiveTimingResponse {
  cutOffTime?: string;
  lines?: LiveTimingLine[];
  sessionPart?: number;
}

// --- Helpers ---

const MIN_SUPPORTED_SEASON = 2018;

export function getActiveSeasonYear(): number {
  const current = new Date().getFullYear();
  return current >= MIN_SUPPORTED_SEASON ? current : MIN_SUPPORTED_SEASON;
}

// Resolves a `?season=` query param into a valid year, clamped to the range
// the season selector offers. Falls back to the active season for anything
// missing or unparseable rather than letting a bad param reach the backend.
export function resolveSeasonYear(seasonParam?: string): number {
  const active = getActiveSeasonYear();
  const parsed = Number(seasonParam);
  if (!seasonParam || !Number.isFinite(parsed)) return active;
  return Math.min(Math.max(Math.trunc(parsed), MIN_SUPPORTED_SEASON), active);
}

// --- API helpers ---

export async function getSeasonRaces(year: number) {
  const data = await fetchJson<{
    races?: Race[];
    races_list?: string[];
    total_races?: number;
  }>("/api/races", {
    year,
    fields: "races,races_list,total",
  }, {
    next: { revalidate: 86400 }, // Cache for 1 day
  });

  if (data.races) {
    data.races.sort((a, b) => {
      const aRound = parseInt(a.round || "0", 10);
      const bRound = parseInt(b.round || "0", 10);
      return aRound - bRound;
    });
  }

  return data;
}

export async function getDriverStandings(year: number) {
  return fetchJson<{
    driver_standings?: DriverStanding[];
  }>("/api/driverstandings", {
    year,
    fields: "standings",
  }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

export async function getConstructorStandings(year: number) {
  return fetchJson<{
    constructor_standings?: ConstructorStanding[];
  }>("/api/constructorstandings", {
    year,
    fields: "standings",
  }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

export async function getRaceResults(year: number, round: number) {
  return fetchJson<{
    race?: Race;
    results?: RaceResult[];
  }>("/api/race_results", {
    year,
    round,
    fields: "race,results",
  }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

export async function getQualifyingResults(year: number, round: number) {
  return fetchJson<{
    race?: Race;
    results?: RaceResult[];
  }>("/api/qualifying_results", {
    year,
    round,
  }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

export interface SeasonRoundResults {
  round: string;
  raceName: string;
  results: RaceResult[];
  qualifying: RaceResult[];
}

// Head-to-head comparisons need every round's race + qualifying results, and
// there's no bulk endpoint for that (unlike _attach_winners on /api/races,
// which only attaches the winner's name). One round trip per round, but
// every one of them is Mongo-cached, so a full season is cheap. Rounds whose
// results fail to fetch (not yet raced, backend miss) just come back empty
// rather than failing the whole comparison.
export async function getSeasonResultsByRound(year: number): Promise<SeasonRoundResults[]> {
  const { races } = await getSeasonRaces(year);
  const rounds = races ?? [];

  const settled = await Promise.allSettled(
    rounds.map(async (race): Promise<SeasonRoundResults> => {
      const roundNumber = Number(race.round);
      const [raceRes, qualiRes] = await Promise.allSettled([
        getRaceResults(year, roundNumber),
        getQualifyingResults(year, roundNumber),
      ]);
      return {
        round: race.round,
        raceName: race.raceName,
        results: raceRes.status === "fulfilled" ? raceRes.value.results ?? [] : [],
        qualifying: qualiRes.status === "fulfilled" ? qualiRes.value.results ?? [] : [],
      };
    })
  );

  return settled
    .filter((r): r is PromiseFulfilledResult<SeasonRoundResults> => r.status === "fulfilled")
    .map((r) => r.value);
}

export async function getSprintResults(year: number, round: number) {
  return fetchJson<{
    race?: Race;
    results?: RaceResult[];
  }>("/api/sprint_results", {
    year,
    round,
  }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

export async function getSessionClassification(
  year: number,
  round: number,
  session: "FP1" | "FP2" | "FP3" | "SQ" | "Q" | "S"
) {
  return fetchJson<{
    session?: string;
    event_name?: string;
    results?: RaceResult[];
  }>("/api/session_classification", {
    year,
    round,
    session,
  }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

export interface DriverBio {
  driverId: string;
  givenName?: string | null;
  familyName?: string | null;
  code?: string | null;
  permanentNumber?: string | null;
  dateOfBirth?: string | null;
  nationality?: string | null;
  wikiUrl?: string | null;
  wins: number;
  podiums: number;
  poles: number;
  championships: number;
}

export async function getDriverBio(driverId: string) {
  return fetchJson<DriverBio>("/api/driver_bio", { driver_id: driverId }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

export interface RaceStint {
  driver_number: number;
  stint_number: number;
  lap_start: number;
  lap_end: number;
  compound: string;
  tyre_age_at_start: number;
}

/** Tyre stints for a finished race, derived from FastF1 and cached in Mongo.
 *
 * `synced` is false when the round hasn't been through the local sync job yet
 * (FastF1's live-timing archive blocks Cloud Run, so the backend can't rebuild
 * it on demand in production) — the UI distinguishes that from "no such race".
 */
export async function getRaceStints(year: number, round: number) {
  return fetchJson<{
    year: number;
    round: number;
    stints: RaceStint[];
    synced: boolean;
  }>("/api/race_stints", {
    year,
    round,
  }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

export interface PitStop {
  driver_id: string;
  lap: number;
  stop: number;
  /** Ergast's raw string, kept because a red-flag stop reads "18:01.553". */
  duration: string;
  duration_seconds: number;
  time: string | null;
}

/** Pit stops for a finished race, from Ergast and cached in Mongo.
 *
 * Unlike `getRaceStints` the backing source is reachable from Cloud Run, so
 * `synced: false` here means the round genuinely has no published stops (a
 * future race) rather than "the local sync job hasn't run".
 */
export async function getPitStops(year: number, round: number) {
  return fetchJson<{
    year: number;
    round: number;
    stops: PitStop[];
    synced: boolean;
  }>("/api/pit_stops", {
    year,
    round,
  }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

export interface RaceLap {
  driver_number: number;
  lap_number: number;
  position: number;
  /** Seconds behind that lap's leader (0 for the leader themselves), or
   * null/absent when it can't be computed — either this specific lap had no
   * usable LapTime to reconstruct a cumulative race time from, or (for a
   * round cached before gap-to-leader existed) the field simply isn't in the
   * cached document at all. Treat "missing" and "null" the same way: no gap
   * data for this lap. */
  gap_seconds?: number | null;
}

/** Per-lap track position and gap-to-leader for a finished race, derived from FastF1 and cached in Mongo.
 *
 * Same `synced` convention as `getRaceStints` — false means the local sync
 * job hasn't populated this round yet, not that the round doesn't exist.
 * `gap_seconds` may be absent on every row for a round synced before it
 * existed — that's a stale-cache degrade, not an error, so the frontend
 * treats it as "gap mode isn't available for this round" rather than
 * retrying or erroring.
 */
export async function getRaceLaps(year: number, round: number) {
  return fetchJson<{
    year: number;
    round: number;
    laps: RaceLap[];
    synced: boolean;
  }>("/api/race_laps", {
    year,
    round,
  }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

/** Static per-driver identity for a replay, sent once rather than repeated on
 * every one of that driver's ~50 lap rows. */
export interface ReplayDriver {
  number: string;
  driver_id: string | null;
  code: string | null;
  name: string;
  team: string | null;
  grid: string | null;
  finish_position: string | null;
  finish_status: string | null;
}

export interface ReplayPit {
  stop_number: number | null;
  duration_seconds: number | null;
}

export interface ReplayRunner {
  /** Car number, the key into `RaceReplay.drivers`. */
  number: string;
  position: number | null;
  gap_seconds?: number | null;
  /** How long this driver's lap actually took, in seconds — the field the
   * real-pace watch clock runs on (see `lib/watch-clock.ts`).
   *
   * **Null is routine, not exceptional.** A driver's opening lap has no
   * measured duration, sparse timing data drops rows, and `race_replay.py`
   * deliberately reports carried-forward rows (retired cars, lapped finishers)
   * as null rather than copying a real measurement onto a lap that driver never
   * ran. Around one row in seven is null on a fully backfilled 2026 round, and
   * a replay cached before Batch 21 has the field missing entirely — hence
   * optional as well as nullable. Any consumer must have a fallback. */
  lap_time_seconds?: number | null;
  compound: string | null;
  tyre_age: number | null;
  stint_number: number | null;
  /** The stop made on this lap, or null for "no stop this lap". */
  pit: ReplayPit | null;
  /** True once this driver has retired — the row is carried forward from
   * their last real lap rather than live, so `gap_seconds`/`position` are
   * frozen at the moment they stopped, not a current gap. */
  retired: boolean;
}

export interface ReplayEvent {
  kind: string;
  drivers: string[];
  message: string;
}

export interface ReplayLap {
  lap: number;
  /** Pre-sorted by position server-side, so nothing re-sorts while scrubbing. */
  runners: ReplayRunner[];
  events: ReplayEvent[];
}

/** A finished race as a lap-indexed timeline.
 *
 * Composed backend-side from `race_laps`, `race_stints`, `pit_stops` and race
 * control (see `race_replay.py`) — chiefly because pit stops key on
 * `driver_id` while laps and stints key on `driver_number`, a join with a
 * silent failure mode that shouldn't be re-derived per caller.
 *
 * Deliberately carries no track coordinates: nothing in this app caches GPS
 * data, so this drives a timing tower, not cars moving around a circuit.
 * `synced: false` with no laps means the round hasn't been processed yet —
 * the same convention as `getRaceLaps`, and not an error.
 */
export interface RaceReplay {
  year: number;
  round: number;
  race_name?: string;
  circuit?: string;
  date?: string;
  total_laps: number;
  drivers: Record<string, ReplayDriver>;
  laps: ReplayLap[];
  synced: boolean;
}

export async function getRaceReplay(year: number, round: number) {
  return fetchJson<RaceReplay>("/api/race_replay", {
    year,
    round,
  }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

/**
 * One gap or interval reading, exactly as OpenF1's `/intervals` feed reports it.
 *
 * **A string is a lapped car and must be rendered verbatim, never parsed.**
 * `"+1 LAP"`, `"+2 LAPS"` and so on are broadcast semantics, not corrupt data:
 * measured against 2026 round 1, `gap_to_leader` is only 79.2% numeric — 4,552
 * of 22,276 rows are strings, and 78 are null. `interval` is 99.2% numeric.
 *
 * That ~20% is the whole reason this is a union rather than `number | null`.
 * Any consumer that assumes numeric will break on real data, and it will break
 * *quietly*: `Number("+1 LAP")` is `NaN`, so a naive `+${value.toFixed(1)}`
 * renders `+NaN` on a fifth of the tower, and arithmetic (interpolation,
 * comparison, "is this car closing?") silently poisons whatever it touches.
 * Every read of this type must branch on `typeof value === "number"` first.
 *
 * `null` is "not reported at this instant" — a genuine absence, not a zero.
 */
export type TimingValue = number | string | null;

/**
 * `[t_ms, interval, gap_to_leader]`.
 *
 * A tuple rather than an object because these arrive ~22k at a time: the
 * measured payload for one round is 454KB raw / 150KB gzipped as tuples, and
 * repeating three JSON keys per sample would roughly triple the raw figure for
 * no gain a reader can see.
 *
 * `t_ms` is **integer milliseconds of elapsed race time**, already resolved
 * server-side against the leader's lap boundaries against the *same* per-lap
 * durations `watch-clock.ts` runs on. A consumer never sees an OpenF1
 * wall-clock timestamp, and must never try to derive one.
 */
export type TimingSample = [number, TimingValue, TimingValue];

/** `[t_ms, position]`. Position is an integer, and these are *changes*, not a
 * grid — roughly 531 across a whole race, so the array is short and sparse. */
export type PositionSample = [number, number];

export interface RaceTimingDriver {
  /** Ascending by `t_ms`, non-empty. ~3.6s median cadence per driver. */
  timing: TimingSample[];
  /** Ascending by `t_ms`, non-empty. Carried forward between entries — a
   * position holds until the next event says otherwise. */
  positions: PositionSample[];
  /**
   * Elapsed time after which this car is out of the race. Absent for a car that
   * took the flag, including a lapped one.
   *
   * Consumers must stop carrying the last position forward past this instant.
   * Without it a retirement keeps its place in the running order for the rest
   * of the race, which also pushes every car behind it down by one.
   */
  out_ms?: number;
}

/**
 * Per-second timing for a finished race, keyed by car number.
 *
 * The intra-lap layer the lap-indexed `RaceReplay` cannot express: `RaceReplay`
 * collapses everything to one row per driver per lap, so a position that
 * changed mid-lap and a gap that closed from 1.4s to 0.4s across half a lap are
 * both invisible in it. This carries the real sampled readings at their native
 * cadence instead, so the tower can count down between line crossings.
 *
 * **Nothing here is interpolated server-side.** These are real measurements at
 * real instants; smoothing is the client's decision (see `watch-timing.ts`) and
 * is deliberately refused wherever a reading is non-numeric.
 *
 * `synced: false` with `drivers: {}` means this round has no per-second track —
 * pre-2023, or not yet ingested. It is **not an error**: same convention as
 * `getRaceLaps` and `getRaceReplay`, and the view degrades to today's
 * lap-stepped tower.
 */
export interface RaceTiming {
  year: number;
  round: number;
  synced: boolean;
  drivers: Record<string, RaceTimingDriver>;
  /**
   * The leader's duration for each lap in ms, index-aligned to laps 1..N.
   *
   * **The clock must run on this whenever it is present, not on
   * `lapDurations(replay.laps)`.** Both describe the same race, but `t_ms` above
   * is measured on *this* timeline — it is elapsed time in the official lap
   * archive, where the replay's durations are a sum of per-lap minima drawn
   * from a different source. Mixing them is what the predecessor did, and the
   * drift between the two is where the position bugs lived: on round 1 it
   * placed the whole opening of the race at half its true offset, so laps 1 and
   * 2 landed on top of each other and rendered in the wrong order.
   *
   * Empty on an unsynced round, where there is no timing to be in step with.
   */
  lap_ms: number[];
}

export async function getRaceTiming(year: number, round: number) {
  return fetchJson<RaceTiming>("/api/race_timing", {
    year,
    round,
  }, {
    next: { revalidate: 3600 }, // Cache for 1 hour
  });
}

export async function getCircuitInfo(year: number, eventName: string) {
  return fetchJson<CircuitInfo>("/api/circuit_info", {
    year,
    event_name: eventName,
  }, {
    next: { revalidate: 86400 }, // Cache for 1 day
  });
}


export function isLiveTimingConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_RAPIDAPI_KEY);
}

export async function getLiveTimingData() {
  const rapidApiKey = process.env.NEXT_PUBLIC_RAPIDAPI_KEY;
  const rapidApiHost =
    process.env.NEXT_PUBLIC_RAPIDAPI_HOST ?? "f1-live-pulse.p.rapidapi.com";

  if (!rapidApiKey) {
    throw new Error("NEXT_PUBLIC_RAPIDAPI_KEY is not configured");
  }

  const response = await fetch(`https://${rapidApiHost}/timingData`, {
    method: "GET",
    headers: {
      "X-Rapidapi-Key": rapidApiKey,
      "X-Rapidapi-Host": rapidApiHost,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`RapidAPI error ${response.status}`);
  }

  return (await response.json()) as LiveTimingResponse;
}

export async function getRaceWeather(year: number, round: number) {
  try {
    return await fetchJson<{
      weather?: {
        air_temperature?: number;
        track_temperature?: number;
        wind_speed?: number;
        wind_direction?: number;
        rainfall?: number;
        humidity?: number;
        pressure?: number;
      } | null;
    }>("/api/race_weather", {
      year,
      round,
    }, {
      next: { revalidate: 3600 }, // Cache for 1 hour
    });
  } catch {
    return { weather: null };
  }
}

// Every field is optional: the sync only stores what FastF1 actually reports
// for a given event, and the modal omits whatever is missing.
export interface TrackInformation {
  first_grand_prix?: number | string | null;
  number_of_laps?: number | null;
  number_of_corners?: number | null;
  lap_record?: string | null;
}

export interface CircuitDetail {
  round: number;
  season?: number;
  country: string;
  circuit_name: string;
  grand_prix: string;
  date: string;
  track_information?: TrackInformation;
}

export async function getCircuitDetails(year?: number): Promise<CircuitDetail[]> {
  try {
    const res = await fetchJson<{ circuit_details: CircuitDetail[] }>(
      "/api/circuit_details",
      { year },
      { next: { revalidate: 3600 } }
    );
    return res.circuit_details ?? [];
  } catch {
    return [];
  }
}

// Cross-season stats for one physical circuit — every field is independently
// optional, since it's pure aggregation over whatever `races`/`race_results`
// happen to be cached for that circuit name; a brand-new circuit or one whose
// older seasons never synced will omit whichever fields it can't compute.
export interface CircuitHistory {
  circuit_name: string;
  first_year?: number;
  most_wins?: {
    driver: string;
    wins: number;
  };
  closest_finish?: {
    gap_seconds: number;
    season: number;
    round: string;
  };
}

export async function getCircuitHistory(
  circuitName: string
): Promise<CircuitHistory | null> {
  try {
    return await fetchJson<CircuitHistory>(
      "/api/circuit_history",
      { circuit_name: circuitName },
      { next: { revalidate: 3600 } }
    );
  } catch {
    return null;
  }
}

// The AI session recap streams plain text rather than JSON, so it's fetched
// directly by the client component (session-recap-card.tsx) via this URL
// rather than through fetchJson — this just centralizes the base-URL logic.
// `session` defaults to "race" to match the backend's default, so every
// existing call site (Race tab) keeps working unchanged.
export type RecapSession = "race" | "qualifying" | "sprint";

export function getSessionRecapUrl(
  year: number,
  round: number,
  session: RecapSession = "race"
): string {
  const url = new URL("/api/session_recap", API_BASE_URL);
  url.searchParams.set("year", String(year));
  url.searchParams.set("round", String(round));
  url.searchParams.set("session", session);
  return url.toString();
}

// The Pitwall "Strategy Commentary" module streams plain text the same way
// the session recap does, so it's fetched directly by its client component
// (strategy-commentary-card.tsx) rather than through fetchJson — this just
// centralizes the base-URL logic, mirroring getSessionRecapUrl above.
export function getStrategyCommentaryUrl(year: number, round: number): string {
  const url = new URL("/api/strategy_commentary", API_BASE_URL);
  url.searchParams.set("year", String(year));
  url.searchParams.set("round", String(round));
  return url.toString();
}

// Same streamed-plain-text convention as getSessionRecapUrl, for the
// driver-comparison narrative (driver-comparison-recap.tsx). driver1/driver2
// are Ergast driverIds (e.g. "verstappen", "norris") -- the same identifiers
// already used to key DriverStanding.Driver.driverId.
export function getDriverComparisonRecapUrl(
  year: number,
  driver1: string,
  driver2: string
): string {
  const url = new URL("/api/driver_comparison_recap", API_BASE_URL);
  url.searchParams.set("year", String(year));
  url.searchParams.set("driver1", driver1);
  url.searchParams.set("driver2", driver2);
  return url.toString();
}

// --- Historical index (Batch 14: 75-Season Barcode + Constructor Genealogy) ---
//
// Both endpoints are backed by `historical_index.py`'s Mongo-cached,
// pre-normalised data (shared-drive de-duplication, chassis/engine-era
// constructor-id collapsing, per-era `alfa` splitting, Indy 500 flagging —
// see that module's docstring). History barely changes, so these use a long
// revalidate window rather than the default 5 minutes.

export interface HistoricalRace {
  season: number;
  round: number;
  date?: string;
  race_name?: string;
  circuit_id?: string;
  driver?: string;
  constructor_key: string;
  constructor_name?: string;
  indy500: boolean;
}

export interface HistoricalRaceIndexResponse {
  races: HistoricalRace[];
  count: number;
}

export async function getHistoricalRaceIndex(
  detail: "full" | "compact" = "full"
): Promise<HistoricalRaceIndexResponse> {
  return fetchJson<HistoricalRaceIndexResponse>(
    "/api/historical_race_index",
    { detail },
    { next: { revalidate: 86400 } } // 24h — 1950-present is static, only today's season tail moves
  );
}

export interface ConstructorSeasonsResponse {
  constructor_id: string;
  seasons: number[];
}

/**
 * @param fresh Bypass Next's fetch cache for this call.
 *
 * The 24-hour revalidate is right for the answer and catastrophic for the
 * non-answer. `/constructor_seasons` is not cached server-side for teams that
 * are still racing, so those ids are re-fetched from Jolpica on every call —
 * and when Jolpica throttles, the backend fails soft to `200 OK` with an empty
 * `seasons` array. Next then caches that empty for a day.
 *
 * Measured, because the symptom hides the cause completely: at the HTTP level
 * the burst of ~40 ids succeeds every time (0 empty at concurrency 4), yet
 * `/teams` rendered "Red Bull — on the grid since 2000, 5 seasons as Jaguar
 * Racing" on every single load. One cold render had poisoned the cache, and
 * the retry loop could not help because the retry hit the same cached empty.
 *
 * So the retry asks for a fresh copy. A genuinely empty id costs a few
 * uncached calls per render; a poisoned entry heals on the next request
 * instead of lasting until tomorrow.
 */
export async function getConstructorSeasons(
  constructorId: string,
  fresh = false
): Promise<ConstructorSeasonsResponse> {
  return fetchJson<ConstructorSeasonsResponse>(
    "/api/constructor_seasons",
    { constructor_id: constructorId },
    fresh ? { cache: "no-store" } : { next: { revalidate: 86400 } }
  );
}

// --- Constructor championships (backend/app/constructor_titles.py) ---------
//
// Every Constructors' Championship, and every Drivers' Championship credited
// to the constructor it was won with, keyed by the same canonical
// constructor key `/api/historical_race_index` uses. Covers 1950 through the
// last COMPLETED season — the season being raced is excluded, because
// mid-season standings name a leader, not a champion.
//
// The response's `complete` flag is not decorative: the backend makes ~144
// Jolpica calls on a cold build, and a partial resolve produces an
// undercount that looks exactly like a real number. Callers must hide the
// counts when it is false. See `ConstructorTitlesResponse` in
// constructor-profiles.ts and that module's provenance header.

export async function getConstructorTitles(): Promise<ConstructorTitlesResponse> {
  return fetchJson<ConstructorTitlesResponse>(
    "/api/constructor_titles",
    undefined,
    { next: { revalidate: 86400 } } // titles only change once a year
  );
}

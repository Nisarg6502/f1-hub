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
  compound: string | null;
  tyre_age: number | null;
  stint_number: number | null;
  /** The stop made on this lap, or null for "no stop this lap". */
  pit: ReplayPit | null;
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

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

type SearchParams = Record<string, string | number | boolean | undefined>;

async function fetchJson<T>(path: string, params?: SearchParams): Promise<T> {
  const url = new URL(path, API_BASE_URL);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined) return;
      url.searchParams.set(key, String(value));
    });
  }

  const res = await fetch(url.toString(), {
    cache: "no-store",
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

export interface DriverInfo {
  driverId: string;
  givenName: string;
  familyName: string;
  code?: string;
  permanentNumber?: string;
  nationality?: string;
  dateOfBirth?: string;
}

export interface ConstructorInfo {
  constructorId: string;
  name: string;
  nationality?: string;
  url?: string;
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
  circuit_name: string | null;
  country: string | null;
  city: string | null;
  track_length_km: number | null;
  total_race_length_km: number | null;
  total_laps: number | null;
  num_corners: number;
  num_drs_zones: number;
  corners: Array<{
    Number: number;
    Name: string | null;
    Type: string | null;
    Distance: number;
  }>;
  drs_zones: Array<{
    Zone: number;
    Start: number;
    End: number;
  }>;
  track_record: {
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

// --- API helpers ---

export async function getSeasonRaces(year: number) {
  const data = await fetchJson<{
    races?: Race[];
    races_list?: string[];
    total_races?: number;
  }>("/api/races", {
    year,
    fields: "races,races_list,total",
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
  });
}

export async function getConstructorStandings(year: number) {
  return fetchJson<{
    constructor_standings?: ConstructorStanding[];
  }>("/api/constructorstandings", {
    year,
    fields: "standings",
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
  });
}

export async function getQualifyingResults(year: number, round: number) {
  return fetchJson<{
    race?: Race;
    results?: RaceResult[];
  }>("/api/qualifying_results", {
    year,
    round,
  });
}

export async function getSprintResults(year: number, round: number) {
  return fetchJson<{
    race?: Race;
    results?: RaceResult[];
  }>("/api/sprint_results", {
    year,
    round,
  });
}

export async function getCircuitInfo(year: number, eventName: string) {
  return fetchJson<CircuitInfo>("/api/circuit_info", {
    year,
    event_name: eventName,
  });
}

export async function getDrivers(year: number) {
  return fetchJson<{
    drivers?: DriverInfo[];
    drivers_list?: string[];
    total_drivers?: number;
  }>("/api/drivers", {
    year,
    fields: "drivers",
  });
}

export async function getConstructors(year: number) {
  return fetchJson<{
    constructors?: ConstructorInfo[];
    constructors_list?: string[];
    total_constructors?: number;
  }>("/api/constructors", {
    year,
    fields: "constructors",
  });
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

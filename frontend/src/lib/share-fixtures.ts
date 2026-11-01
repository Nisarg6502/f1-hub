/**
 * Backend-shaped fixtures for the share-card route tests.
 *
 * Shaped exactly like the JSON `/api/driverstandings`, `/api/race_results` and
 * friends return — field names, string-typed numbers and all — because the
 * routes are tested end to end through a stubbed `fetch`, and a fixture in a
 * friendlier shape would test a backend that does not exist.
 *
 * The cases are the ones a real season does not reliably provide on demand: a
 * season with nothing raced, a retirement inside the top ten, constructor
 * names long enough to overflow, drivers with no portrait.
 */

import type { ConstructorStanding, DriverStanding, Race, RaceResult } from "./api";

type Driver = { given: string; family: string; code: string; team: string; id?: string };

const GRID: Driver[] = [
  { given: "Andrea Kimi", family: "Antonelli", code: "ANT", team: "Mercedes" },
  { given: "George", family: "Russell", code: "RUS", team: "Mercedes" },
  { given: "Lewis", family: "Hamilton", code: "HAM", team: "Ferrari" },
  { given: "Max", family: "Verstappen", code: "VER", team: "Red Bull" },
  { given: "Charles", family: "Leclerc", code: "LEC", team: "Ferrari" },
  { given: "Lando", family: "Norris", code: "NOR", team: "McLaren" },
  { given: "Nico", family: "Hülkenberg", code: "HUL", team: "Audi" },
  { given: "Sergio", family: "Pérez", code: "PER", team: "Cadillac F1 Team" },
  { given: "Yuki", family: "Tsunoda", code: "TSU", team: "RB F1 Team" },
  { given: "Oscar", family: "Piastri", code: "PIA", team: "McLaren" },
  { given: "Fernando", family: "Alonso", code: "ALO", team: "Aston Martin" },
  { given: "Carlos", family: "Sainz", code: "SAI", team: "Williams" },
];

const idOf = (d: Driver) => d.id ?? d.family.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Standings with a three-way tie on 7 points and a two-way tie on 0. */
export function fixtureDriverStandings(): DriverStanding[] {
  const points = [340, 238, 229, 221, 215, 201, 13, 7, 7, 7, 0, 0];
  return GRID.map((d, i) => ({
    position: String(i + 1),
    points: String(points[i]),
    wins: String(i < 4 ? 4 - i : 0),
    Driver: { driverId: idOf(d), givenName: d.given, familyName: d.family, code: d.code },
    Constructors: [{ constructorId: d.team.toLowerCase(), name: d.team }],
  }));
}

/** A field of real 2024-era long-form entrant names, the longest the sport has used. */
export function fixtureLongConstructorStandings(): ConstructorStanding[] {
  const names = [
    "Mercedes-AMG Petronas Formula One Team",
    "Scuderia Ferrari HP",
    "McLaren Formula 1 Team",
    "Oracle Red Bull Racing",
    "Visa Cash App Racing Bulls Formula One Team",
    "BWT Alpine Formula One Team",
    "MoneyGram Haas F1 Team",
    "Stake F1 Team Kick Sauber",
    "Atlassian Williams Racing",
    "Aston Martin Aramco Formula One Team",
    "Cadillac Formula 1 Team",
  ];
  const points = [578, 444, 339, 332, 100, 68, 30, 23, 12, 7, 7];
  return names.map((name, i) => ({
    position: String(i + 1),
    points: String(points[i]),
    wins: String(i < 3 ? 6 - i * 2 : 0),
    Constructor: { constructorId: `team_${i}`, name },
  }));
}

export function fixtureRace(round: number, raceName: string, opts: { sprint?: boolean; winner?: boolean } = {}): Race {
  return {
    raceName,
    round: String(round),
    season: "2026",
    date: "2026-05-24",
    time: "20:00:00Z",
    Circuit: { circuitId: "x", circuitName: "Circuit", Location: { locality: "Town", country: "Country" } },
    ...(opts.sprint ? { Sprint: { date: "2026-05-23", time: "16:00:00Z" } } : {}),
    ...(opts.winner ? { winner: { givenName: "George", familyName: "Russell", code: "RUS" } } : {}),
  };
}

/**
 * A race whose top ten includes a retirement (P8, `positionText: "R"`) and a
 * disqualification (P10, `"D"`). Real classifications place both at the back,
 * which is why this has to be a fixture — the card's job is still to state
 * them honestly if the data ever has them there, rather than print a gap.
 */
export function fixtureRaceResultsWithDnf(): RaceResult[] {
  return GRID.slice(0, 12).map((d, i) => {
    const position = String(i + 1);
    const base: RaceResult = {
      number: String(i + 1),
      position,
      positionText: position,
      points: String([25, 18, 15, 12, 10, 8, 6, 4, 2, 1, 0, 0][i]),
      laps: "58",
      status: "Finished",
      Driver: { driverId: idOf(d), givenName: d.given, familyName: d.family, code: d.code },
      Constructor: { constructorId: d.team.toLowerCase(), name: d.team },
      Time: i === 0 ? { time: "1:23:06.801" } : { time: `+${(i * 2.317).toFixed(3)}` },
    };
    if (i === 6) return { ...base, status: "+1 Lap", Time: undefined, laps: "57" };
    if (i === 7) return { ...base, positionText: "R", status: "Engine", Time: undefined, laps: "51" };
    if (i === 9) return { ...base, positionText: "D", status: "Disqualified", Time: undefined };
    return base;
  });
}

/** JSON `Response` the way `fetchJson` expects it. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Width and height from a PNG's IHDR chunk, or `null` if it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

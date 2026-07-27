import type { RaceResult, SeasonRoundResults } from "./api";

// "1:23.456" -> 83456ms; "23.456" (a rare fast Q1 lap with no minutes) -> 23456ms.
export function parseQualiTimeMs(time?: string | null): number | null {
  if (!time) return null;
  const match = time.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return Math.round((minutes * 60 + seconds) * 1000);
}

function findResult(results: RaceResult[], driverId: string): RaceResult | undefined {
  return results.find((r) => r.Driver?.driverId === driverId);
}

export interface RaceRoundComparison {
  round: string;
  raceName: string;
  positionA: number | null;
  positionB: number | null;
}

export interface QualiRoundComparison {
  round: string;
  raceName: string;
  segment: "Q1" | "Q2" | "Q3";
  msA: number;
  msB: number;
}

export interface HeadToHeadSummary {
  raceRounds: RaceRoundComparison[];
  raceCommonCount: number;
  raceAheadA: number;
  raceAheadB: number;
  qualiRounds: QualiRoundComparison[];
  qualiCommonCount: number;
  qualiAheadA: number;
  qualiAheadB: number;
  avgQualiGapMs: number | null;
}

// Compares two drivers on whichever qualifying segment they BOTH reached
// (Q3 first, falling back to Q2 then Q1) -- comparing a driver eliminated in
// Q2 against the other's Q3 time would understate how close they actually
// were in the segment they both ran.
function bestCommonQualiTime(
  a: RaceResult,
  b: RaceResult
): { segment: "Q1" | "Q2" | "Q3"; msA: number; msB: number } | null {
  for (const segment of ["Q3", "Q2", "Q1"] as const) {
    const msA = parseQualiTimeMs(a[segment]);
    const msB = parseQualiTimeMs(b[segment]);
    if (msA !== null && msB !== null) {
      return { segment, msA, msB };
    }
  }
  return null;
}

export function buildHeadToHead(
  rounds: SeasonRoundResults[],
  driverAId: string,
  driverBId: string
): HeadToHeadSummary {
  const raceRounds: RaceRoundComparison[] = [];
  const qualiRounds: QualiRoundComparison[] = [];

  for (const round of rounds) {
    const resultA = findResult(round.results, driverAId);
    const resultB = findResult(round.results, driverBId);
    if (resultA && resultB) {
      const positionA = resultA.position ? Number(resultA.position) : NaN;
      const positionB = resultB.position ? Number(resultB.position) : NaN;
      raceRounds.push({
        round: round.round,
        raceName: round.raceName,
        positionA: Number.isFinite(positionA) ? positionA : null,
        positionB: Number.isFinite(positionB) ? positionB : null,
      });
    }

    const qualiA = findResult(round.qualifying, driverAId);
    const qualiB = findResult(round.qualifying, driverBId);
    if (qualiA && qualiB) {
      const common = bestCommonQualiTime(qualiA, qualiB);
      if (common) {
        qualiRounds.push({ round: round.round, raceName: round.raceName, ...common });
      }
    }
  }

  const raceAheadA = raceRounds.filter(
    (r) => r.positionA !== null && r.positionB !== null && r.positionA < r.positionB
  ).length;
  const raceAheadB = raceRounds.filter(
    (r) => r.positionA !== null && r.positionB !== null && r.positionB < r.positionA
  ).length;

  const qualiAheadA = qualiRounds.filter((r) => r.msA < r.msB).length;
  const qualiAheadB = qualiRounds.filter((r) => r.msB < r.msA).length;
  const avgQualiGapMs = qualiRounds.length
    ? qualiRounds.reduce((sum, r) => sum + (r.msA - r.msB), 0) / qualiRounds.length
    : null;

  return {
    raceRounds,
    raceCommonCount: raceRounds.length,
    raceAheadA,
    raceAheadB,
    qualiRounds,
    qualiCommonCount: qualiRounds.length,
    qualiAheadA,
    qualiAheadB,
    avgQualiGapMs,
  };
}

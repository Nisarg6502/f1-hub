import type { Race } from "@/lib/api";

export type RaceSessionField =
  | "FirstPractice"
  | "SecondPractice"
  | "ThirdPractice"
  | "SprintQualifying"
  | "Sprint"
  | "Qualifying"
  | "Race";

export interface SessionTimelineItem {
  id: string;
  season?: string;
  round?: string;
  raceName: string;
  circuitName?: string;
  sessionField: RaceSessionField;
  sessionLabel: string;
  startTimeMs: number;
  endTimeMs: number;
  startIso: string;
}

const SESSION_META: Array<{
  field: RaceSessionField;
  label: string;
  durationMinutes: number;
}> = [
  { field: "FirstPractice", label: "FP1", durationMinutes: 60 },
  { field: "SecondPractice", label: "FP2", durationMinutes: 60 },
  { field: "ThirdPractice", label: "FP3", durationMinutes: 60 },
  { field: "SprintQualifying", label: "Sprint Shootout", durationMinutes: 45 },
  { field: "Sprint", label: "Sprint", durationMinutes: 30 },
  { field: "Qualifying", label: "Qualifying", durationMinutes: 60 },
  { field: "Race", label: "Race", durationMinutes: 120 },
];

function parseSessionTimestamp(date?: string, time?: string): number | null {
  if (!date) return null;
  const baseTime = time ?? "12:00:00Z";
  const iso = baseTime.endsWith("Z")
    ? `${date}T${baseTime}`
    : `${date}T${baseTime}Z`;
  const parsed = new Date(iso);
  const timestamp = parsed.getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function parseDateTimeToMs(date?: string, time?: string): number | null {
  return parseSessionTimestamp(date, time);
}

export function buildSeasonSessionTimeline(races: Race[]): SessionTimelineItem[] {
  const sessions: SessionTimelineItem[] = [];

  races.forEach((race) => {
    SESSION_META.forEach((meta) => {
      const timestamp =
        meta.field === "Race"
          ? parseSessionTimestamp(race.date, race.time)
          : parseSessionTimestamp(race[meta.field]?.date, race[meta.field]?.time);

      if (timestamp === null) {
        return;
      }

      sessions.push({
        id: `${race.season ?? "season"}-${race.round ?? "round"}-${meta.field}-${timestamp}`,
        season: race.season,
        round: race.round,
        raceName: race.raceName,
        circuitName: race.Circuit?.circuitName,
        sessionField: meta.field,
        sessionLabel: meta.label,
        startTimeMs: timestamp,
        endTimeMs: timestamp + meta.durationMinutes * 60 * 1000,
        startIso: new Date(timestamp).toISOString(),
      });
    });
  });

  return sessions.sort((a, b) => a.startTimeMs - b.startTimeMs);
}

export function buildRaceSessionTimeline(race?: Race): SessionTimelineItem[] {
  if (!race) return [];
  return buildSeasonSessionTimeline([race]);
}

export function getCurrentLiveSession(
  sessions: SessionTimelineItem[],
  nowMs = Date.now()
): SessionTimelineItem | null {
  return sessions.find(
    (session) => session.startTimeMs <= nowMs && nowMs < session.endTimeMs
  ) ?? null;
}

export function getNextSession(
  sessions: SessionTimelineItem[],
  nowMs = Date.now()
): SessionTimelineItem | null {
  return sessions.find((session) => session.startTimeMs > nowMs) ?? null;
}

export function getUpcomingSessions(
  sessions: SessionTimelineItem[],
  nowMs = Date.now(),
  limit = 3
): SessionTimelineItem[] {
  return sessions.filter((session) => session.startTimeMs > nowMs).slice(0, limit);
}

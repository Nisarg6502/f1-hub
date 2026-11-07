import type { Race } from "./api";

/**
 * The season's sessions as calendar entries, and the iCalendar (RFC 5545)
 * feed built from them.
 *
 * Shared by the public `.ics` feed (`/api/calendar/[...name]`) and the email
 * reminder dispatcher, so "which sessions exist and when" has one answer.
 *
 * Pure — races in, strings out — so the feed is unit-tested and parsed back
 * with a real iCalendar parser without a server.
 */

/** The session kinds a person can choose to follow. */
export const CALENDAR_SESSION_TYPES = [
  "race",
  "sprint",
  "qualifying",
  "sprint-qualifying",
  "practice",
] as const;
export type CalendarSessionType = (typeof CALENDAR_SESSION_TYPES)[number];

export const SESSION_TYPE_LABELS: Record<CalendarSessionType, string> = {
  race: "Race",
  sprint: "Sprint",
  qualifying: "Qualifying",
  "sprint-qualifying": "Sprint Qualifying",
  practice: "Practice",
};

/**
 * What the feed carries when the URL names no types: everything except
 * practice. Practice triples the event count for the sessions fewest people
 * watch, so it is opt-in.
 */
export const DEFAULT_SESSION_TYPES: CalendarSessionType[] = [
  "race",
  "sprint",
  "qualifying",
  "sprint-qualifying",
];

type SessionField =
  | "FirstPractice"
  | "SecondPractice"
  | "ThirdPractice"
  | "SprintQualifying"
  | "Sprint"
  | "Qualifying"
  | "Race";

const SESSION_META: {
  field: SessionField;
  type: CalendarSessionType;
  label: string;
  minutes: number;
}[] = [
  { field: "FirstPractice", type: "practice", label: "Practice 1", minutes: 60 },
  { field: "SecondPractice", type: "practice", label: "Practice 2", minutes: 60 },
  { field: "ThirdPractice", type: "practice", label: "Practice 3", minutes: 60 },
  { field: "SprintQualifying", type: "sprint-qualifying", label: "Sprint Qualifying", minutes: 45 },
  { field: "Sprint", type: "sprint", label: "Sprint", minutes: 60 },
  { field: "Qualifying", type: "qualifying", label: "Qualifying", minutes: 60 },
  { field: "Race", type: "race", label: "Race", minutes: 120 },
];

export interface CalendarSession {
  /**
   * Stable identity: season, round and session, and NOTHING time-based. A
   * rescheduled session keeps its id, which is what lets a calendar move the
   * existing event instead of adding a second one, and what keys the
   * reminder dedupe so a moved session is not reminded twice.
   */
  id: string;
  season: string;
  round: string;
  raceName: string;
  circuitName?: string;
  locality?: string;
  country?: string;
  type: CalendarSessionType;
  label: string;
  startMs: number;
  endMs: number;
  /**
   * False when the schedule has a date but no start time yet (early in a
   * season's announcement). Such a session becomes an all-day event in the
   * feed and is never the subject of a timed reminder.
   */
  timed: boolean;
}

function parseStart(date?: string, time?: string): { ms: number; timed: boolean } | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const timed = Boolean(time);
  const clock = time ?? "00:00:00Z";
  const iso = `${date}T${clock.endsWith("Z") ? clock : `${clock}Z`}`;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : { ms, timed };
}

/** Every session of the given races, sorted by start. */
export function extractSessions(races: Race[]): CalendarSession[] {
  const out: CalendarSession[] = [];
  for (const race of races) {
    if (!race.round) continue;
    const season = race.season ?? (race.date ? race.date.slice(0, 4) : "");
    if (!season) continue;
    for (const meta of SESSION_META) {
      const slot =
        meta.field === "Race" ? { date: race.date, time: race.time } : race[meta.field];
      const start = parseStart(slot?.date, slot?.time);
      if (!start) continue;
      out.push({
        id: `${season}-${race.round}-${meta.field.toLowerCase()}`,
        season,
        round: race.round,
        raceName: race.raceName,
        circuitName: race.Circuit?.circuitName,
        locality: race.Circuit?.Location?.locality,
        country: race.Circuit?.Location?.country,
        type: meta.type,
        label: meta.label,
        startMs: start.ms,
        endMs: start.ms + meta.minutes * 60_000,
        timed: start.timed,
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}

/**
 * `?sessions=race,qualifying` → the chosen types, in canonical order.
 * Unknown names are ignored (an old link keeps working if a type is renamed);
 * absent or empty-after-filtering falls back to the defaults rather than
 * serving an empty calendar nobody asked for. `all` selects every type.
 */
export function parseSessionTypes(raw: string | null | undefined): CalendarSessionType[] {
  if (!raw) return [...DEFAULT_SESSION_TYPES];
  const asked = raw
    .toLowerCase()
    .split(/[,\s+]+/)
    .map((part) => part.trim().replace(/_/g, "-"))
    .filter(Boolean);
  if (asked.includes("all")) return [...CALENDAR_SESSION_TYPES];
  const picked = CALENDAR_SESSION_TYPES.filter((type) => asked.includes(type));
  return picked.length > 0 ? picked : [...DEFAULT_SESSION_TYPES];
}

/** The query value for a set of types — the inverse of `parseSessionTypes`. */
export function formatSessionTypes(types: readonly CalendarSessionType[]): string {
  return CALENDAR_SESSION_TYPES.filter((type) => types.includes(type)).join(",");
}

export function filterSessions(
  sessions: CalendarSession[],
  types: readonly CalendarSessionType[]
): CalendarSession[] {
  return sessions.filter((session) => types.includes(session.type));
}

// --- iCalendar ---

/** RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma, newline. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * RFC 5545 §3.1: lines longer than 75 OCTETS are folded with CRLF + space.
 * Counted in UTF-8 bytes, and never splitting a multi-byte character, so a
 * circuit name like "Autódromo José Carlos Pace" folds into valid UTF-8.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  // The first line may hold 75 octets; continuation lines 74 plus the space.
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** `20261108T140000Z` */
export function icsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** `20261108` */
function icsDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * SEQUENCE for every event in a feed generated at `nowMs`: whole hours since
 * 2025-01-01 UTC.
 *
 * RFC 5545 says a client should apply an update only when SEQUENCE has gone
 * up. The feed keeps no history, so it cannot know which events changed since
 * a given client last looked; what it CAN guarantee is that a later
 * generation never carries a lower SEQUENCE than an earlier one. A moved
 * session therefore always reaches a calendar that imported the old file —
 * the case that matters — and an unchanged event re-delivered with a higher
 * SEQUENCE is simply rewritten with identical content. Hours rather than
 * seconds keeps the number small (about 8,800 a year, far inside the 32-bit
 * INTEGER limit) and matches the feed's one-hour cache, so the value is
 * constant across one cached response.
 */
export function feedSequence(nowMs: number): number {
  const epoch = Date.UTC(2025, 0, 1);
  return Math.max(0, Math.floor((nowMs - epoch) / 3_600_000));
}

export interface IcsOptions {
  /** Public origin for event links, e.g. https://f1-frontend-…run.app */
  siteUrl: string;
  /** Feed generation time: DTSTAMP and SEQUENCE derive from it. */
  nowMs: number;
  /** Calendar display name. */
  name?: string;
  /** Minutes before start for the VALARM; 0 or less omits alarms. */
  alarmMinutes?: number;
}

/** UID domain. Fixed, not the request host: the same event must keep the same
 *  UID whichever of Cloud Run's two hostnames served it. */
const UID_DOMAIN = "apex-f1-hub";

export function eventSummary(session: CalendarSession): string {
  return `F1: ${session.raceName.replace(/ Grand Prix$/, " GP")} – ${session.label}`;
}

export function sessionUrl(siteUrl: string, session: Pick<CalendarSession, "season" | "round">): string {
  return `${siteUrl.replace(/\/+$/, "")}/schedule/${session.season}/${session.round}`;
}

export function buildIcs(sessions: CalendarSession[], options: IcsOptions): string {
  const { siteUrl, nowMs, name = "F1 sessions · APEX", alarmMinutes = 30 } = options;
  const stamp = icsUtc(nowMs);
  const sequence = feedSequence(nowMs);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//APEX F1 Hub//Race calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(name)}`,
    `X-WR-CALDESC:${escapeIcsText(
      "Formula 1 session times from APEX, an unofficial season hub. Times are UTC; your calendar shows them in your own time zone."
    )}`,
    "X-WR-TIMEZONE:UTC",
    // How often subscribed clients should re-fetch. Apple and Outlook honour
    // these; Google refreshes on its own schedule (roughly daily) regardless.
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];

  for (const session of sessions) {
    const place = [session.circuitName, session.locality, session.country]
      .filter(Boolean)
      .join(", ");
    const url = sessionUrl(siteUrl, session);
    const description = [
      `${session.raceName}, round ${session.round} of the ${session.season} season.`,
      session.timed ? "" : "Start time not announced yet.",
      `Session page: ${url}`,
    ]
      .filter(Boolean)
      .join("\n");

    lines.push(
      "BEGIN:VEVENT",
      `UID:${session.id}@${UID_DOMAIN}`,
      `DTSTAMP:${stamp}`,
      `SEQUENCE:${sequence}`
    );
    if (session.timed) {
      lines.push(`DTSTART:${icsUtc(session.startMs)}`, `DTEND:${icsUtc(session.endMs)}`);
    } else {
      lines.push(
        `DTSTART;VALUE=DATE:${icsDate(session.startMs)}`,
        `DTEND;VALUE=DATE:${icsDate(session.startMs + 86_400_000)}`
      );
    }
    lines.push(
      `SUMMARY:${escapeIcsText(eventSummary(session))}`,
      ...(place ? [`LOCATION:${escapeIcsText(place)}`] : []),
      `DESCRIPTION:${escapeIcsText(description)}`,
      `URL:${url}`,
      "STATUS:CONFIRMED",
      "TRANSP:TRANSPARENT",
      // A list value: the comma separates categories and is not escaped.
      `CATEGORIES:Formula 1,${escapeIcsText(SESSION_TYPE_LABELS[session.type])}`
    );
    if (session.timed && alarmMinutes > 0) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeIcsText(`${eventSummary(session)} starts in ${alarmMinutes} minutes`)}`,
        `TRIGGER:-PT${Math.round(alarmMinutes)}M`,
        "END:VALARM"
      );
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

// --- Subscribe links ---

export interface FeedLinks {
  https: string;
  webcal: string;
  google: string;
  download: string;
}

/**
 * The three ways to add the feed. `webcal://` is the same URL with its scheme
 * swapped, which Apple Calendar and Outlook open as a subscription. Google
 * takes the webcal URL as `cid`; it fetches from Google's servers, so it only
 * works for a publicly reachable origin.
 */
export function feedLinks(origin: string, types: readonly CalendarSessionType[]): FeedLinks {
  const base = origin.replace(/\/+$/, "");
  const query = `sessions=${formatSessionTypes(types)}`;
  const https = `${base}/api/calendar/apex-f1.ics?${query}`;
  const webcal = https.replace(/^https?:\/\//, "webcal://");
  return {
    https,
    webcal,
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
    download: `${https}&download=1`,
  };
}

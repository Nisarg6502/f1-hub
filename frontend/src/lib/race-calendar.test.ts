import { describe, expect, it } from "vitest";
import ICAL from "ical.js";
import type { Race } from "./api";
import {
  buildIcs,
  escapeIcsText,
  extractSessions,
  feedLinks,
  feedSequence,
  filterSessions,
  foldIcsLine,
  parseSessionTypes,
} from "./race-calendar";

const races: Race[] = [
  {
    season: "2026",
    round: "21",
    raceName: "São Paulo Grand Prix",
    date: "2026-11-08",
    time: "17:00:00Z",
    Circuit: {
      circuitName: "Autódromo José Carlos Pace",
      Location: { locality: "São Paulo", country: "Brazil" },
    },
    FirstPractice: { date: "2026-11-06", time: "14:30:00Z" },
    SprintQualifying: { date: "2026-11-06", time: "18:30:00Z" },
    Sprint: { date: "2026-11-07", time: "14:00:00Z" },
    Qualifying: { date: "2026-11-07", time: "18:00:00Z" },
  },
  {
    season: "2026",
    round: "22",
    raceName: "Las Vegas Grand Prix",
    date: "2026-11-22",
    time: "04:00:00Z",
    Circuit: {
      circuitName: "Las Vegas Strip Circuit",
      Location: { locality: "Las Vegas", country: "USA" },
    },
    FirstPractice: { date: "2026-11-20" },
    Qualifying: { date: "2026-11-21", time: "04:00:00Z" },
  },
];

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const SITE = "https://apex.example";

function parse(ics: string) {
  const component = new ICAL.Component(ICAL.parse(ics));
  return { calendar: component, events: component.getAllSubcomponents("vevent") };
}

describe("extractSessions", () => {
  const sessions = extractSessions(races);

  it("finds every session with a date, sorted by start", () => {
    expect(sessions.map((s) => s.id)).toEqual([
      "2026-21-firstpractice",
      "2026-21-sprintqualifying",
      "2026-21-sprint",
      "2026-21-qualifying",
      "2026-21-race",
      "2026-22-firstpractice",
      "2026-22-qualifying",
      "2026-22-race",
    ]);
  });

  it("keeps ids free of start times so a reschedule keeps the same UID", () => {
    const moved = structuredClone(races);
    moved[0].time = "18:00:00Z";
    const before = sessions.find((s) => s.type === "race")!;
    const after = extractSessions(moved).find((s) => s.type === "race")!;
    expect(after.id).toBe(before.id);
    expect(after.startMs).not.toBe(before.startMs);
  });

  it("marks a session with no start time as untimed", () => {
    const fp1 = sessions.find((s) => s.id === "2026-22-firstpractice")!;
    expect(fp1.timed).toBe(false);
  });
});

describe("parseSessionTypes", () => {
  it("defaults to everything but practice", () => {
    expect(parseSessionTypes(null)).toEqual(["race", "sprint", "qualifying", "sprint-qualifying"]);
  });
  it("reads a list, ignores unknowns, accepts underscores", () => {
    expect(parseSessionTypes("qualifying,bogus,sprint_qualifying")).toEqual([
      "qualifying",
      "sprint-qualifying",
    ]);
  });
  it("falls back to defaults when nothing valid is named", () => {
    expect(parseSessionTypes("bogus")).toHaveLength(4);
  });
  it("accepts all", () => {
    expect(parseSessionTypes("all")).toHaveLength(5);
  });
});

describe("text helpers", () => {
  it("escapes RFC 5545 TEXT specials", () => {
    expect(escapeIcsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });
  it("folds at 75 octets without splitting multi-byte characters", () => {
    const line = "LOCATION:" + "São Paulo, ".repeat(20);
    const folded = foldIcsLine(line);
    for (const part of folded.split("\r\n")) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });
});

describe("buildIcs", () => {
  const sessions = filterSessions(extractSessions(races), parseSessionTypes("all"));
  const ics = buildIcs(sessions, { siteUrl: SITE, nowMs: NOW });

  it("uses CRLF line endings throughout", () => {
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("parses with a real iCalendar parser", () => {
    const { calendar, events } = parse(ics);
    expect(calendar.getFirstPropertyValue("version")).toBe("2.0");
    expect(calendar.getFirstPropertyValue("prodid")).toContain("APEX");
    expect(events).toHaveLength(sessions.length);
  });

  it("gives each event a stable UID, a DTSTAMP and a SEQUENCE", () => {
    const { events } = parse(ics);
    const uids = events.map((e) => e.getFirstPropertyValue("uid"));
    expect(new Set(uids).size).toBe(uids.length);
    expect(uids[0]).toBe("2026-21-firstpractice@apex-f1-hub");
    for (const event of events) {
      expect(event.getFirstPropertyValue("dtstamp")).toBeTruthy();
      expect(event.getFirstPropertyValue("sequence")).toBe(feedSequence(NOW));
    }
  });

  it("writes timed sessions in UTC with a 30-minute alarm", () => {
    const { events } = parse(ics);
    const race = events.find((e) => e.getFirstPropertyValue("uid") === "2026-21-race@apex-f1-hub")!;
    const event = new ICAL.Event(race);
    expect(event.startDate.toJSDate().toISOString()).toBe("2026-11-08T17:00:00.000Z");
    expect(event.endDate.toJSDate().toISOString()).toBe("2026-11-08T19:00:00.000Z");
    expect(event.startDate.zone?.tzid).toBe("UTC");
    expect(event.summary).toBe("F1: São Paulo GP – Race");
    expect(event.location).toBe("Autódromo José Carlos Pace, São Paulo, Brazil");
    const alarm = race.getFirstSubcomponent("valarm")!;
    expect(alarm.getFirstPropertyValue("action")).toBe("DISPLAY");
    expect(String(alarm.getFirstPropertyValue("trigger"))).toBe("-PT30M");
  });

  it("writes an untimed session as an all-day event without an alarm", () => {
    const { events } = parse(ics);
    const fp1 = events.find((e) => e.getFirstPropertyValue("uid") === "2026-22-firstpractice@apex-f1-hub")!;
    const event = new ICAL.Event(fp1);
    expect(event.startDate.isDate).toBe(true);
    expect(fp1.getFirstSubcomponent("valarm")).toBeNull();
  });

  it("only raises SEQUENCE over time, so a later feed always supersedes", () => {
    expect(feedSequence(NOW + 3_600_000)).toBeGreaterThan(feedSequence(NOW));
    expect(feedSequence(NOW + 60_000)).toBe(feedSequence(NOW));
  });

  it("produces a valid empty calendar for no sessions", () => {
    const { events } = parse(buildIcs([], { siteUrl: SITE, nowMs: NOW }));
    expect(events).toHaveLength(0);
  });
});

describe("feedLinks", () => {
  it("builds webcal, Google and download links from one URL", () => {
    const links = feedLinks("https://apex.example/", ["race", "qualifying"]);
    expect(links.https).toBe("https://apex.example/api/calendar/apex-f1.ics?sessions=race,qualifying");
    expect(links.webcal).toBe("webcal://apex.example/api/calendar/apex-f1.ics?sessions=race,qualifying");
    expect(links.google).toBe(
      `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(links.webcal)}`
    );
    expect(links.download).toBe(`${links.https}&download=1`);
  });
});

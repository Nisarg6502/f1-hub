import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ICAL from "ical.js";

/**
 * The HTTP edges of calendar feeds and reminders, with Mongo, SMTP and the
 * backend replaced: the dispatch endpoint's secret gate (inert when unset),
 * the feed's status codes and body, and the unsubscribe link.
 */

vi.mock("server-only", () => ({}));

const disableReminders = vi.fn(async (userId: string) => userId.length > 0);
const listEnabled = vi.fn(async () => []);
vi.mock("@/lib/reminders-store", () => ({
  disableReminders: (userId: string) => disableReminders(userId),
  mongoReminderStore: () => ({
    listEnabledSubscriptions: listEnabled,
    countSendsSince: async () => 0,
    wasClaimed: async () => false,
    claimSend: async () => true,
    markSend: async () => {},
  }),
}));
vi.mock("@/lib/reminders-mailer", () => ({
  createReminderMailer: async () => ({ send: async () => {} }),
}));

const getSeasonRaces = vi.fn();
vi.mock("@/lib/api", () => ({
  getActiveSeasonYear: () => 2026,
  getSeasonRaces: (year: number) => getSeasonRaces(year),
}));

const { POST: dispatch } = await import("@/app/api/reminders/dispatch/route");
const { GET: feed } = await import("@/app/api/calendar/[...name]/route");
const unsubscribe = await import("@/app/api/reminders/unsubscribe/route");
const { signUnsubscribeToken } = await import("./reminders");

const RACES = {
  races: [
    {
      season: "2026",
      round: "21",
      raceName: "São Paulo Grand Prix",
      date: "2026-11-08",
      time: "17:00:00Z",
      Qualifying: { date: "2026-11-07", time: "18:00:00Z" },
      FirstPractice: { date: "2026-11-06", time: "14:30:00Z" },
    },
  ],
};

const env = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  getSeasonRaces.mockResolvedValue(RACES);
});
afterEach(() => {
  process.env = { ...env };
});

function post(headers: Record<string, string> = {}, query = "") {
  return new Request(`http://localhost:3105/api/reminders/dispatch${query}`, { method: "POST", headers });
}

describe("POST /api/reminders/dispatch", () => {
  it("is inert (404) when REMINDERS_DISPATCH_SECRET is unset, whatever is sent", async () => {
    delete process.env.REMINDERS_DISPATCH_SECRET;
    const res = await dispatch(post({ "x-reminders-secret": "" }));
    expect(res.status).toBe(404);
    expect(listEnabled).not.toHaveBeenCalled();
  });

  it("refuses a missing or wrong secret", async () => {
    process.env.REMINDERS_DISPATCH_SECRET = "s3cret-value";
    expect((await dispatch(post())).status).toBe(401);
    expect((await dispatch(post({ "x-reminders-secret": "wrong" }))).status).toBe(401);
    expect(listEnabled).not.toHaveBeenCalled();
  });

  it("runs with the right secret", async () => {
    process.env.REMINDERS_DISPATCH_SECRET = "s3cret-value";
    process.env.MONGODB_URI = "mongodb://unused";
    process.env.BETTER_AUTH_SECRET = "auth-secret";
    const res = await dispatch(post({ "x-reminders-secret": "s3cret-value" }, "?dryRun=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ dryRun: true, sent: 0, cap: 400 });
    expect(listEnabled).toHaveBeenCalledTimes(1);
  });
});

function feedRequest(path: string) {
  const url = new URL(path, "http://localhost:3105");
  const name = url.pathname.replace("/api/calendar/", "").split("/");
  return feed(new Request(url), { params: Promise.resolve({ name }) });
}

describe("GET /api/calendar/[...name]", () => {
  it("serves a parseable calendar with only the chosen session types", async () => {
    const res = await feedRequest("/api/calendar/apex-f1.ics?sessions=race,qualifying");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBeNull();
    const cal = new ICAL.Component(ICAL.parse(await res.text()));
    const uids = cal.getAllSubcomponents("vevent").map((e) => e.getFirstPropertyValue("uid"));
    expect(uids).toEqual(["2026-21-qualifying@apex-f1-hub", "2026-21-race@apex-f1-hub"]);
  });

  it("serves an attachment for download=1", async () => {
    const res = await feedRequest("/api/calendar/apex-f1.ics?download=1");
    expect(res.headers.get("content-disposition")).toContain('filename="apex-f1-2026.ics"');
  });

  it("404s a name that is not a .ics file", async () => {
    expect((await feedRequest("/api/calendar/feed.json")).status).toBe(404);
    expect((await feedRequest("/api/calendar/a/b.ics")).status).toBe(404);
  });

  it("answers 503, not an empty calendar, when the schedule is unavailable", async () => {
    getSeasonRaces.mockRejectedValue(new Error("down"));
    expect((await feedRequest("/api/calendar/apex-f1.ics")).status).toBe(503);
  });
});

describe("/api/reminders/unsubscribe", () => {
  beforeEach(() => {
    process.env.MONGODB_URI = "mongodb://unused";
    process.env.BETTER_AUTH_SECRET = "auth-secret";
  });

  it("unsubscribes on GET with a valid token, without signing in", async () => {
    const token = signUnsubscribeToken("user-1", "auth-secret");
    const res = await unsubscribe.GET(
      new Request(`http://localhost:3105/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`)
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("unsubscribed");
    expect(disableReminders).toHaveBeenCalledWith("user-1");
  });

  it("supports RFC 8058 one-click POST", async () => {
    const token = signUnsubscribeToken("user-2", "auth-secret");
    const res = await unsubscribe.POST(
      new Request(`http://localhost:3105/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
      })
    );
    expect(res.status).toBe(200);
    expect(disableReminders).toHaveBeenCalledWith("user-2");
  });

  it("rejects a forged token and changes nothing", async () => {
    const token = signUnsubscribeToken("user-1", "some-other-secret");
    const res = await unsubscribe.GET(
      new Request(`http://localhost:3105/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`)
    );
    expect(res.status).toBe(400);
    expect(disableReminders).not.toHaveBeenCalled();
  });
});

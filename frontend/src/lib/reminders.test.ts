import { describe, expect, it } from "vitest";
import type { CalendarSession } from "./race-calendar";
import {
  dispatchReminders,
  pickReminderSettings,
  renderReminderEmail,
  secretsMatch,
  selectDueReminders,
  signUnsubscribeToken,
  validateReminderSettings,
  verifyUnsubscribeToken,
  type ReminderEmail,
  type ReminderStore,
  type ReminderSubscription,
  type SendKey,
} from "./reminders";

const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 8, 17, 0, 0);

function session(overrides: Partial<CalendarSession> = {}): CalendarSession {
  return {
    id: "2026-21-race",
    season: "2026",
    round: "21",
    raceName: "São Paulo Grand Prix",
    circuitName: "Interlagos",
    locality: "São Paulo",
    country: "Brazil",
    type: "race",
    label: "Race",
    startMs: START,
    endMs: START + 2 * HOUR,
    timed: true,
    ...overrides,
  };
}

function sub(overrides: Partial<ReminderSubscription> = {}): ReminderSubscription {
  return {
    userId: "u1",
    email: "u1@example.com",
    enabled: true,
    sessionTypes: ["race"],
    leadMinutes: 60,
    ...overrides,
  };
}

/** In-memory store with the same unique-key semantics as the Mongo index. */
function memoryStore(subs: ReminderSubscription[]) {
  const claims = new Map<string, { at: Date; status: string }>();
  const k = (key: SendKey) => `${key.userId}|${key.sessionId}|${key.leadMinutes}`;
  const store: ReminderStore = {
    async listEnabledSubscriptions() {
      return subs.filter((s) => s.enabled);
    },
    async countSendsSince(since) {
      return [...claims.values()].filter((c) => c.at >= since).length;
    },
    async wasClaimed(key) {
      return claims.has(k(key));
    },
    async claimSend(key, at) {
      if (claims.has(k(key))) return false;
      claims.set(k(key), { at, status: "claimed" });
      return true;
    },
    async markSend(key, outcome) {
      const claim = claims.get(k(key));
      if (claim) claim.status = outcome.status;
    },
  };
  return { store, claims };
}

function recordingMailer(fail = false) {
  const sent: ({ to: string } & ReminderEmail)[] = [];
  return {
    sent,
    mailer: {
      async send(message: { to: string } & ReminderEmail) {
        if (fail) throw new Error("smtp down");
        sent.push(message);
      },
    },
  };
}

const SECRET = "test-secret-0123456789abcdef";
const base = { siteUrl: "https://apex.example", tokenSecret: SECRET, dailyCap: 400 };

describe("selectDueReminders", () => {
  it("is due from start − lead until the start", () => {
    const sessions = [session()];
    const subs = [sub({ leadMinutes: 60 })];
    expect(selectDueReminders(sessions, subs, START - HOUR - 1)).toHaveLength(0);
    expect(selectDueReminders(sessions, subs, START - HOUR)).toHaveLength(1);
    expect(selectDueReminders(sessions, subs, START - 1)).toHaveLength(1);
    expect(selectDueReminders(sessions, subs, START)).toHaveLength(0);
  });

  it("uses each subscriber's own lead time", () => {
    const subs = [sub({ userId: "a", leadMinutes: 15 }), sub({ userId: "b", leadMinutes: 1440 })];
    const due = selectDueReminders([session()], subs, START - 2 * HOUR);
    expect(due.map((d) => d.subscription.userId)).toEqual(["b"]);
  });

  it("only picks the subscriber's session types", () => {
    const sessions = [session(), session({ id: "2026-21-qualifying", type: "qualifying", startMs: START - 10 * 60_000 })];
    const due = selectDueReminders(sessions, [sub({ sessionTypes: ["qualifying"] })], START - 30 * 60_000);
    expect(due.map((d) => d.session.id)).toEqual(["2026-21-qualifying"]);
  });

  it("skips disabled subscribers and sessions without a start time", () => {
    const now = START - 10 * 60_000;
    expect(selectDueReminders([session()], [sub({ enabled: false })], now)).toHaveLength(0);
    expect(selectDueReminders([session({ timed: false })], [sub()], now)).toHaveLength(0);
  });

  it("sorts soonest session first", () => {
    const sessions = [session(), session({ id: "early", startMs: START - 20 * 60_000 })];
    const due = selectDueReminders(sessions, [sub()], START - 30 * 60_000);
    expect(due.map((d) => d.session.id)).toEqual(["early", "2026-21-race"]);
  });
});

describe("dispatchReminders", () => {
  it("sends each reminder once across repeated runs", async () => {
    const { store, claims } = memoryStore([sub()]);
    const { mailer, sent } = recordingMailer();
    const opts = { ...base, sessions: [session()], store, mailer };
    const first = await dispatchReminders({ ...opts, nowMs: START - 50 * 60_000 });
    const second = await dispatchReminders({ ...opts, nowMs: START - 40 * 60_000 });
    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.alreadySent).toBe(1);
    expect(sent).toHaveLength(1);
    expect([...claims.values()][0].status).toBe("sent");
  });

  it("does not double-send when two runs overlap", async () => {
    const { store } = memoryStore([sub()]);
    const { mailer, sent } = recordingMailer();
    const opts = { ...base, sessions: [session()], store, mailer, nowMs: START - 30 * 60_000 };
    await Promise.all([dispatchReminders(opts), dispatchReminders(opts)]);
    expect(sent).toHaveLength(1);
  });

  it("sends again for a different lead time (a new reminder, not a duplicate)", async () => {
    const subs = [sub({ leadMinutes: 1440 })];
    const { store } = memoryStore(subs);
    const { mailer, sent } = recordingMailer();
    await dispatchReminders({ ...base, sessions: [session()], store, mailer, nowMs: START - 20 * HOUR });
    subs[0].leadMinutes = 60;
    await dispatchReminders({ ...base, sessions: [session()], store, mailer, nowMs: START - 30 * 60_000 });
    expect(sent).toHaveLength(2);
  });

  it("does not retry a failed send", async () => {
    const { store, claims } = memoryStore([sub()]);
    const failing = recordingMailer(true);
    const report = await dispatchReminders({ ...base, sessions: [session()], store, mailer: failing.mailer, nowMs: START - 30 * 60_000 });
    expect(report.failed).toBe(1);
    expect([...claims.values()][0].status).toBe("failed");
    const ok = recordingMailer();
    await dispatchReminders({ ...base, sessions: [session()], store, mailer: ok.mailer, nowMs: START - 20 * 60_000 });
    expect(ok.sent).toHaveLength(0);
  });

  it("stops at the rolling daily cap and defers the rest", async () => {
    const subs = Array.from({ length: 5 }, (_, i) => sub({ userId: `u${i}`, email: `u${i}@example.com` }));
    const { store } = memoryStore(subs);
    const { mailer, sent } = recordingMailer();
    const report = await dispatchReminders({ ...base, dailyCap: 3, sessions: [session()], store, mailer, nowMs: START - 30 * 60_000 });
    expect(report.sent).toBe(3);
    expect(report.deferredByCap).toBe(2);
    expect(sent).toHaveLength(3);
    // The next run in the same day has no budget left.
    const later = await dispatchReminders({ ...base, dailyCap: 3, sessions: [session()], store, mailer, nowMs: START - 20 * 60_000 });
    expect(later.sent).toBe(0);
    expect(later.deferredByCap).toBe(2);
  });

  it("does not claim (or lose) a reminder whose message cannot be built", async () => {
    const { store, claims } = memoryStore([sub(), sub({ userId: "u2", email: "u2@example.com" })]);
    const { mailer, sent } = recordingMailer();
    const report = await dispatchReminders({ ...base, tokenSecret: "", sessions: [session()], store, mailer, nowMs: START - 30 * 60_000 });
    expect(report.failed).toBe(2);
    expect(claims.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("re-checks the cap against the ledger before each send", async () => {
    const subs = Array.from({ length: 4 }, (_, i) => sub({ userId: `u${i}`, email: `u${i}@example.com` }));
    const { store } = memoryStore(subs);
    const { mailer } = recordingMailer();
    const opts = { ...base, dailyCap: 2, sessions: [session()], store, mailer, nowMs: START - 30 * 60_000 };
    const [a, b] = await Promise.all([dispatchReminders(opts), dispatchReminders(opts)]);
    expect(a.sent + b.sent).toBeLessThanOrEqual(3);
  });

  it("dry run claims and sends nothing", async () => {
    const { store, claims } = memoryStore([sub()]);
    const { mailer, sent } = recordingMailer();
    const report = await dispatchReminders({ ...base, dryRun: true, sessions: [session()], store, mailer, nowMs: START - 30 * 60_000 });
    expect(report.items[0].outcome).toBe("would-send");
    expect(sent).toHaveLength(0);
    expect(claims.size).toBe(0);
  });

  it("puts a working unsubscribe link in the body and the List-Unsubscribe header", async () => {
    const { store } = memoryStore([sub({ userId: "665f1c2e9b1d4a0012345678" })]);
    const { mailer, sent } = recordingMailer();
    await dispatchReminders({ ...base, sessions: [session()], store, mailer, nowMs: START - 30 * 60_000 });
    const message = sent[0];
    const header = message.headers["List-Unsubscribe"];
    expect(message.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const url = new URL(header.slice(1, -1));
    expect(url.pathname).toBe("/api/reminders/unsubscribe");
    expect(verifyUnsubscribeToken(url.searchParams.get("token"), SECRET)).toBe("665f1c2e9b1d4a0012345678");
    expect(message.text).toContain(url.toString());
  });
});

describe("renderReminderEmail", () => {
  const message = renderReminderEmail({
    session: session(),
    leadMinutes: 60,
    timeZone: "Asia/Kolkata",
    siteUrl: "https://apex.example",
    unsubscribe: "https://apex.example/api/reminders/unsubscribe?token=x",
  });

  it("names the session and shows UTC and the reader's zone", () => {
    expect(message.subject).toBe("Race starts in 1 hour · São Paulo Grand Prix");
    expect(message.text).toContain("17:00 UTC");
    expect(message.text).toContain("22:30 GMT+5:30");
    expect(message.text).toContain("https://apex.example/schedule/2026/21");
  });

  it("says the time actually left when sent late in the window", () => {
    const late = renderReminderEmail({
      session: session(),
      leadMinutes: 1440,
      siteUrl: "https://apex.example",
      unsubscribe: "https://apex.example/u",
      nowMs: START - 3 * HOUR,
    });
    expect(late.subject).toBe("Race starts in 3 hours · São Paulo Grand Prix");
    expect(late.text).toContain("remind you 1 day before");
  });

  it("carries no result vocabulary (spoiler-safe)", () => {
    for (const part of [message.subject, message.text, message.html]) {
      expect(part).not.toMatch(/\b(won|winner|wins|podium|P1|pole|result)\b/i);
    }
  });

  it("escapes HTML in schedule fields", () => {
    const html = renderReminderEmail({
      session: session({ raceName: "<script>x</script> GP" }),
      leadMinutes: 15,
      siteUrl: "https://apex.example",
      unsubscribe: "https://apex.example/u",
    }).html;
    expect(html).not.toContain("<script>x");
  });
});

describe("unsubscribe token", () => {
  it("round-trips the user id", () => {
    const token = signUnsubscribeToken("user-123", SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toBe("user-123");
  });

  it("rejects a token signed with another secret, a tampered id, or junk", () => {
    const token = signUnsubscribeToken("user-123", SECRET);
    expect(verifyUnsubscribeToken(token, "other-secret")).toBeNull();
    const [, sig] = token.split(".");
    const forged = `${Buffer.from("user-999").toString("base64url")}.${sig}`;
    expect(verifyUnsubscribeToken(forged, SECRET)).toBeNull();
    expect(verifyUnsubscribeToken("nope", SECRET)).toBeNull();
    expect(verifyUnsubscribeToken("", SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(null, SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(token, undefined)).toBeNull();
    expect(verifyUnsubscribeToken(`${token}x`, SECRET)).toBeNull();
  });
});

describe("secretsMatch", () => {
  it("matches only the exact secret, and never when unset", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abd", "abc")).toBe(false);
    expect(secretsMatch("abcd", "abc")).toBe(false);
    expect(secretsMatch(null, "abc")).toBe(false);
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch("abc", undefined)).toBe(false);
  });
});

describe("settings validation", () => {
  it("accepts a valid body and orders types canonically", () => {
    const result = validateReminderSettings({
      enabled: true,
      sessionTypes: ["qualifying", "race"],
      leadMinutes: 15,
      timeZone: "Europe/London",
    });
    expect(result).toEqual({
      ok: true,
      settings: { enabled: true, sessionTypes: ["race", "qualifying"], leadMinutes: 15, timeZone: "Europe/London" },
    });
  });

  it("refuses unknown fields, bad leads, bad zones and an empty enabled list", () => {
    expect(validateReminderSettings({ enabled: true, sessionTypes: ["race"], leadMinutes: 7 }).ok).toBe(false);
    expect(validateReminderSettings({ enabled: true, sessionTypes: [], leadMinutes: 60 }).ok).toBe(false);
    expect(validateReminderSettings({ enabled: true, sessionTypes: ["race"], leadMinutes: 60, timeZone: "Mars/Base" }).ok).toBe(false);
    expect(validateReminderSettings({ enabled: true, sessionTypes: ["race"], leadMinutes: 60, email: "x" }).ok).toBe(false);
    expect(validateReminderSettings({ enabled: false, sessionTypes: [], leadMinutes: 60 }).ok).toBe(true);
  });

  it("reads defaults from a missing document", () => {
    expect(pickReminderSettings(null)).toMatchObject({ enabled: false, leadMinutes: 60 });
  });
});

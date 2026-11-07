import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SESSION_TYPE_LABELS, sessionUrl, type CalendarSession } from "./race-calendar";
import { isValidTimeZone, leadLabel, type ReminderSettings } from "./reminder-settings";

export * from "./reminder-settings";

/**
 * Email reminders before F1 sessions: the settings shape, which reminders
 * are due, the dedupe-and-cap dispatch loop, the message, and the signed
 * unsubscribe token.
 *
 * Everything here is pure or takes its I/O as an argument (`ReminderStore`,
 * `ReminderMailer`), so the rules that matter — never twice, never over the
 * cap, never a result in the message — are unit-tested without Mongo or
 * SMTP. The Mongo store is `reminders-store.ts`; the HTTP edges are
 * `/api/me/reminders`, `/api/reminders/dispatch` and
 * `/api/reminders/unsubscribe`.
 *
 * SPOILERS: a reminder is about a session that has NOT started, and the
 * message is built only from schedule fields (names, circuit, start time).
 * No result, standing or winner is ever passed to the renderer, so there is
 * nothing for spoiler-free mode to hide.
 */

// --- Which reminders are due ---

export interface ReminderSubscription extends ReminderSettings {
  userId: string;
  email: string;
}

export interface DueReminder {
  subscription: ReminderSubscription;
  session: CalendarSession;
}

/**
 * Every (subscriber, session) pair whose reminder window is open at `nowMs`:
 * the session starts within the subscriber's lead time and has not started.
 *
 *     start − lead ≤ now < start
 *
 * The whole remaining lead window, not a slice of it the width of the
 * scheduler interval: a run that is late, skipped or failed is made up by the
 * next one, and the dedupe record (not the window) is what stops a second
 * email. Sessions without an announced start time are never due.
 *
 * Sorted soonest-session first, so when the daily cap bites it is the
 * reminders furthest from their session that wait.
 */
export function selectDueReminders(
  sessions: CalendarSession[],
  subscriptions: ReminderSubscription[],
  nowMs: number
): DueReminder[] {
  const due: DueReminder[] = [];
  for (const subscription of subscriptions) {
    if (!subscription.enabled || !subscription.email) continue;
    const leadMs = subscription.leadMinutes * 60_000;
    for (const session of sessions) {
      if (!session.timed) continue;
      if (!subscription.sessionTypes.includes(session.type)) continue;
      if (nowMs >= session.startMs - leadMs && nowMs < session.startMs) {
        due.push({ subscription, session });
      }
    }
  }
  return due.sort(
    (a, b) =>
      a.session.startMs - b.session.startMs ||
      a.subscription.userId.localeCompare(b.subscription.userId)
  );
}

// --- Unsubscribe token ---

/**
 * `<base64url user id>.<base64url HMAC-SHA256>` over a domain-separated
 * message, keyed by the server secret. Proves the link was minted here for
 * this user, so it works without signing in and cannot be forged for anyone
 * else. It does not expire: an unsubscribe link in a months-old email must
 * still work, and all it can ever do is turn reminders OFF.
 */
const TOKEN_CONTEXT = "apex-reminders-unsubscribe:v1:";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function mac(userId: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(TOKEN_CONTEXT + userId).digest();
}

export function signUnsubscribeToken(userId: string, secret: string): string {
  if (!secret) throw new Error("No signing secret");
  return `${b64url(userId)}.${b64url(mac(userId, secret))}`;
}

/** The user id the token was minted for, or null for anything invalid. */
export function verifyUnsubscribeToken(token: unknown, secret: string | undefined): string | null {
  if (!secret || typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let userId: string;
  let given: Buffer;
  try {
    userId = Buffer.from(parts[0], "base64url").toString("utf8");
    given = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }
  if (!userId || userId.length > 128) return null;
  const expected = mac(userId, secret);
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? userId : null;
}

/**
 * Constant-time comparison of a presented secret with the configured one.
 * Both sides are hashed first so the comparison is always over 32 bytes and
 * reveals nothing about the configured secret's length.
 */
export function secretsMatch(presented: string | null | undefined, configured: string | undefined): boolean {
  if (!configured || typeof presented !== "string") return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}

export function unsubscribeUrl(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`;
}

// --- The message ---

export interface ReminderEmail {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "45 minutes", "3 hours", "1 day": rounded to what a person would say. */
export function timeLeftLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 15) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes < 90) return `${Math.round(minutes / 5) * 5} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function formatIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date(ms));
}

/**
 * Only schedule facts go in: session, event, round, circuit, start time,
 * links. See the SPOILERS note at the top of the file.
 */
export function renderReminderEmail({
  session,
  leadMinutes,
  timeZone,
  siteUrl,
  unsubscribe,
  nowMs,
}: {
  session: CalendarSession;
  leadMinutes: number;
  timeZone?: string;
  siteUrl: string;
  unsubscribe: string;
  /** Send time. When given, "starts in …" is the time actually left. */
  nowMs?: number;
}): ReminderEmail {
  const base = siteUrl.replace(/\/+$/, "");
  const link = sessionUrl(base, session);
  const manage = `${base}/account#reminders`;
  const utc = formatIn(session.startMs, "UTC");
  const local = timeZone && timeZone !== "UTC" && isValidTimeZone(timeZone)
    ? formatIn(session.startMs, timeZone)
    : null;
  const where = [session.circuitName, session.locality, session.country].filter(Boolean).join(", ");
  const title = `${session.raceName} – ${session.label}`;
  // The time actually left, not the chosen lead: a reminder can go out late
  // in its window (turned on 3 hours before a 1-day lead, or caught up after
  // a missed run), and "starts in 1 day" three hours out would be wrong.
  const startsIn = nowMs === undefined ? leadLabel(leadMinutes) : timeLeftLabel(session.startMs - nowMs);
  const subject = `${session.label} starts in ${startsIn} · ${session.raceName}`;

  const text = [
    title,
    "",
    `Starts: ${utc}${local ? `\nYour time: ${local}` : ""}`,
    where ? `Where: ${where}` : "",
    `Round ${session.round} of the ${session.season} season.`,
    "",
    `Follow it on APEX: ${link}`,
    "",
    `You asked APEX to remind you ${leadLabel(leadMinutes)} before ${SESSION_TYPE_LABELS[session.type].toLowerCase()} sessions.`,
    `Change what you get: ${manage}`,
    `Unsubscribe from all reminders: ${unsubscribe}`,
    "",
    "APEX is an unofficial Formula 1 season hub. Not affiliated with Formula 1.",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#0a0908;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0908;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#1a1613;border:1px solid #2a231d;border-radius:16px;">
<tr><td style="padding:28px 28px 8px 28px;font-family:Helvetica,Arial,sans-serif;">
<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#ff5a1f;vertical-align:middle;"></span>
<span style="font-size:20px;font-weight:800;letter-spacing:-0.5px;color:#f6f1ea;vertical-align:middle;margin-left:8px;">APEX</span>
</td></tr>
<tr><td style="padding:12px 28px 0 28px;font-family:Helvetica,Arial,sans-serif;color:#f6f1ea;">
<p style="margin:0 0 6px 0;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#ff5a1f;">Starts in ${escapeHtml(startsIn)}</p>
<h1 style="margin:0 0 14px 0;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(title)}</h1>
<p style="margin:0 0 4px 0;font-size:15px;line-height:1.55;color:#f6f1ea;">${escapeHtml(utc)}</p>
${local ? `<p style="margin:0 0 4px 0;font-size:15px;line-height:1.55;color:#c9c0b4;">Your time: ${escapeHtml(local)}</p>` : ""}
${where ? `<p style="margin:8px 0 0 0;font-size:13px;line-height:1.55;color:#a89e90;">${escapeHtml(where)} · Round ${escapeHtml(session.round)}</p>` : ""}
</td></tr>
<tr><td style="padding:22px 28px 0 28px;">
<a href="${escapeHtml(link)}" style="display:inline-block;background:#ff5a1f;color:#1a1210;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:12px;">Open on APEX</a>
</td></tr>
<tr><td style="padding:24px 28px 28px 28px;font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.6;color:#877e72;border-top:1px solid #2a231d;margin-top:24px;">
You asked APEX to remind you ${escapeHtml(leadLabel(leadMinutes))} before ${escapeHtml(SESSION_TYPE_LABELS[session.type].toLowerCase())} sessions.
<a href="${escapeHtml(manage)}" style="color:#ffae6a;">Change reminders</a> ·
<a href="${escapeHtml(unsubscribe)}" style="color:#ffae6a;">Unsubscribe</a><br>
An unofficial Formula 1 season hub. Not affiliated with Formula 1.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return {
    subject,
    text,
    html,
    headers: {
      // RFC 2369 + RFC 8058: Gmail and Apple Mail show their own one-click
      // "Unsubscribe" and POST `List-Unsubscribe=One-Click` to this URL.
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

// --- Dispatch ---

export interface SendKey {
  userId: string;
  sessionId: string;
  leadMinutes: number;
}

export interface ReminderStore {
  listEnabledSubscriptions(): Promise<ReminderSubscription[]>;
  /** Sends claimed since `since`, whatever their outcome: they all used quota. */
  countSendsSince(since: Date): Promise<number>;
  /** True when a send for this key has been claimed before. */
  wasClaimed(key: SendKey): Promise<boolean>;
  /**
   * Atomically record intent to send. False when the key is already claimed
   * (the unique index refused it) — another run, or an earlier one, owns it.
   */
  claimSend(key: SendKey, at: Date): Promise<boolean>;
  markSend(key: SendKey, outcome: { status: "sent" | "failed"; error?: string }): Promise<void>;
}

export interface ReminderMailer {
  send(message: { to: string } & ReminderEmail): Promise<void>;
}

export interface DispatchOptions {
  sessions: CalendarSession[];
  store: ReminderStore;
  mailer: ReminderMailer;
  nowMs: number;
  siteUrl: string;
  /** Signs unsubscribe tokens. */
  tokenSecret: string;
  /** Rolling 24-hour ceiling on sends, which also bounds a single run. */
  dailyCap: number;
  /** Report what would be sent; claim and send nothing. */
  dryRun?: boolean;
}

export interface DispatchReport {
  dryRun: boolean;
  due: number;
  sent: number;
  failed: number;
  alreadySent: number;
  deferredByCap: number;
  usedToday: number;
  cap: number;
  /** Per-reminder lines for dry runs and logs. No addresses. */
  items: { sessionId: string; leadMinutes: number; outcome: string }[];
}

export const DEFAULT_DAILY_CAP = 400;

/**
 * Send every due reminder exactly once, within the cap.
 *
 * AT MOST ONCE, by construction: the send is CLAIMED (a unique-indexed
 * insert on user × session × lead) before the email goes out, and the claim
 * is never released. Two overlapping runs cannot both win the insert, and a
 * send that fails — or that succeeded but whose acknowledgement was lost —
 * is recorded rather than retried. A missed reminder is a small annoyance; a
 * duplicate on every scheduler tick is the kind of thing that gets a sender
 * marked as spam.
 *
 * The cap counts claims in the last 24 hours (Gmail's limit is per rolling
 * day), so a run near the limit sends only what is left and reports the rest
 * as deferred; they go out on a later run if their window is still open.
 */
export async function dispatchReminders(options: DispatchOptions): Promise<DispatchReport> {
  const { sessions, store, mailer, nowMs, siteUrl, tokenSecret, dailyCap, dryRun = false } = options;
  const subscriptions = await store.listEnabledSubscriptions();
  const due = selectDueReminders(sessions, subscriptions, nowMs);
  const usedToday = await store.countSendsSince(new Date(nowMs - 86_400_000));
  let budget = Math.max(0, dailyCap - usedToday);

  const report: DispatchReport = {
    dryRun,
    due: due.length,
    sent: 0,
    failed: 0,
    alreadySent: 0,
    deferredByCap: 0,
    usedToday,
    cap: dailyCap,
    items: [],
  };

  for (const { subscription, session } of due) {
    const key: SendKey = {
      userId: subscription.userId,
      sessionId: session.id,
      leadMinutes: subscription.leadMinutes,
    };
    const item = { sessionId: session.id, leadMinutes: subscription.leadMinutes, outcome: "" };
    report.items.push(item);

    if (await store.wasClaimed(key)) {
      report.alreadySent++;
      item.outcome = "already-sent";
      continue;
    }
    // Re-counted from the ledger before every real send, not only at the
    // start of the run, so two overlapping runs (a Scheduler retry landing on
    // a normal tick) cannot together spend twice what is left of the day.
    const overCap =
      budget <= 0 ||
      (!dryRun && (await store.countSendsSince(new Date(nowMs - 86_400_000))) >= dailyCap);
    if (overCap) {
      report.deferredByCap++;
      item.outcome = "deferred-cap";
      continue;
    }

    // Built BEFORE claiming: if rendering or signing throws, nothing is
    // claimed, so the reminder is not silently lost, and the run carries on.
    let message: ReminderEmail;
    try {
      message = renderReminderEmail({
        session,
        leadMinutes: subscription.leadMinutes,
        timeZone: subscription.timeZone,
        siteUrl,
        unsubscribe: unsubscribeUrl(siteUrl, signUnsubscribeToken(subscription.userId, tokenSecret)),
        nowMs,
      });
    } catch {
      report.failed++;
      item.outcome = "render-failed";
      continue;
    }

    if (dryRun) {
      budget--;
      item.outcome = "would-send";
      continue;
    }
    if (!(await store.claimSend(key, new Date(nowMs)))) {
      report.alreadySent++;
      item.outcome = "already-sent";
      continue;
    }
    budget--;

    try {
      await mailer.send({ to: subscription.email, ...message });
      await store.markSend(key, { status: "sent" });
      report.sent++;
      item.outcome = "sent";
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await store.markSend(key, { status: "failed", error: reason.slice(0, 300) }).catch(() => {});
      report.failed++;
      item.outcome = "failed";
    }
  }

  return report;
}

import { NextResponse } from "next/server";
import { getActiveSeasonYear, getSeasonRaces, type Race } from "@/lib/api";
import { isAuthConfigured } from "@/lib/auth-db";
import { extractSessions } from "@/lib/race-calendar";
import { DEFAULT_DAILY_CAP, dispatchReminders, secretsMatch } from "@/lib/reminders";
import { createReminderMailer } from "@/lib/reminders-mailer";
import { mongoReminderStore } from "@/lib/reminders-store";
import { publicSiteUrl } from "@/lib/site-url";

/**
 * `POST /api/reminders/dispatch` — send the reminder emails that are due.
 * Called by Cloud Scheduler every ten minutes with the header
 * `X-Reminders-Secret: <REMINDERS_DISPATCH_SECRET>`.
 *
 * INERT WITHOUT THE SECRET: when `REMINDERS_DISPATCH_SECRET` is unset this
 * answers 404 before touching anything, so a deployment that has not been
 * given the secret has no dispatch endpoint at all. With it set, a request
 * without the matching header gets 401 (compared in constant time).
 *
 * `?dryRun=1` reports what would be sent and records and sends nothing.
 *
 * All the rules — window, dedupe, cap — live in `lib/reminders.ts`.
 */
export const dynamic = "force-dynamic";
// Sending a few hundred SMTP messages takes a while; do not let the platform
// default cut a run off half-way.
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };
const DISPATCH_SECRET_HEADER = "x-reminders-secret";

async function loadSessions(nowMs: number) {
  const season = getActiveSeasonYear();
  const seasons = [season];
  // A one-day lead in late December can reach into January's schedule.
  if (new Date(nowMs).getUTCMonth() === 11) seasons.push(season + 1);
  const results = await Promise.allSettled(seasons.map((year) => getSeasonRaces(year)));
  const first = results[0];
  if (first.status === "rejected") throw first.reason;
  const races: Race[] = results.flatMap((r) => (r.status === "fulfilled" ? (r.value.races ?? []) : []));
  return extractSessions(races);
}

export async function POST(request: Request) {
  const configured = process.env.REMINDERS_DISPATCH_SECRET;
  if (!configured) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }
  if (!secretsMatch(request.headers.get(DISPATCH_SECRET_HEADER), configured)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isAuthConfigured()) {
    return NextResponse.json({ error: "accounts_not_configured" }, { status: 503, headers: NO_STORE });
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const nowMs = Date.now();

  let sessions;
  try {
    sessions = await loadSessions(nowMs);
  } catch {
    return NextResponse.json({ error: "schedule_unavailable" }, { status: 503, headers: NO_STORE });
  }

  const capEnv = Number(process.env.REMINDERS_DAILY_CAP);
  const dailyCap = Number.isFinite(capEnv) && capEnv >= 0 ? Math.floor(capEnv) : DEFAULT_DAILY_CAP;

  try {
    const report = await dispatchReminders({
      sessions,
      store: mongoReminderStore(),
      mailer: dryRun
        ? { send: async () => {} }
        : await createReminderMailer(),
      nowMs,
      siteUrl: publicSiteUrl(request),
      tokenSecret: process.env.BETTER_AUTH_SECRET as string,
      dailyCap,
      dryRun,
    });
    console.info(
      `[reminders] dispatch dryRun=${report.dryRun} due=${report.due} sent=${report.sent} failed=${report.failed} already=${report.alreadySent} deferred=${report.deferredByCap} used24h=${report.usedToday}/${report.cap}`
    );
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (error) {
    console.error("[reminders] dispatch failed", error);
    return NextResponse.json({ error: "dispatch_failed" }, { status: 500, headers: NO_STORE });
  }
}

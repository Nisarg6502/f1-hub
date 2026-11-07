import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { validateReminderSettings } from "@/lib/reminders";
import { readReminderSettings, writeReminderSettings } from "@/lib/reminders-store";

/**
 * `GET /api/me/reminders` — the signed-in user's email reminder settings.
 * `PUT /api/me/reminders` — replace them (the whole settings object).
 *
 * Kept apart from `/api/me/preferences`: reminders live in their own
 * collection (`reminder_subscriptions`) because the dispatcher queries them
 * across all users. See `lib/reminders-store.ts`.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 2048;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed_out" }, { status: 401, headers: NO_STORE });
  return NextResponse.json({ reminders: await readReminderSettings(user.id) }, { headers: NO_STORE });
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed_out" }, { status: 401, headers: NO_STORE });

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid", message: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }
  const result = validateReminderSettings(body);
  if (!result.ok) {
    return NextResponse.json({ error: "invalid", message: result.error }, { status: 400, headers: NO_STORE });
  }
  const reminders = await writeReminderSettings({ id: user.id, email: user.email }, result.settings);
  return NextResponse.json({ reminders }, { headers: NO_STORE });
}

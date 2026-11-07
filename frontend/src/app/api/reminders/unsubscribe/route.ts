import { isAuthConfigured } from "@/lib/auth-db";
import { verifyUnsubscribeToken } from "@/lib/reminders";
import { disableReminders } from "@/lib/reminders-store";

/**
 * `GET|POST /api/reminders/unsubscribe?token=…` — turn reminder emails off,
 * no sign-in needed. The token is the signed one from the email
 * (`signUnsubscribeToken`), so it can only ever switch off the reminders of
 * the account it was minted for.
 *
 * GET is the link in the email body: one click, done, with a page saying so.
 * POST is RFC 8058 one-click, sent by Gmail / Apple Mail from their own
 * "Unsubscribe" button via the `List-Unsubscribe-Post` header; it answers
 * with a bare 200.
 *
 * Unsubscribing on GET means a link scanner that follows every URL in an
 * email can switch reminders off. That is the accepted trade for a genuinely
 * one-click link: the action is idempotent, only ever turns mail OFF, and is
 * undone with one toggle on /account.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

async function unsubscribe(request: Request): Promise<"ok" | "invalid" | "unavailable"> {
  if (!isAuthConfigured()) return "unavailable";
  const token = new URL(request.url).searchParams.get("token");
  const userId = verifyUnsubscribeToken(token, process.env.BETTER_AUTH_SECRET);
  if (!userId) return "invalid";
  await disableReminders(userId);
  return "ok";
}

function page(title: string, body: string, status: number) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · APEX</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0908;font-family:Helvetica,Arial,sans-serif;color:#f6f1ea;">
<main style="max-width:420px;margin:24px;padding:28px;background:#1a1613;border:1px solid #2a231d;border-radius:16px;">
<p style="margin:0 0 14px 0;font-weight:800;font-size:18px;"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#ff5a1f;margin-right:8px;"></span>APEX</p>
<h1 style="margin:0 0 10px 0;font-size:22px;">${title}</h1>
<p style="margin:0 0 18px 0;font-size:15px;line-height:1.55;color:#c9c0b4;">${body}</p>
<a href="/account#reminders" style="color:#ffae6a;font-size:14px;">Manage reminders</a> · <a href="/schedule" style="color:#ffae6a;font-size:14px;">Race calendar</a>
</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
  });
}

export async function GET(request: Request) {
  const result = await unsubscribe(request);
  if (result === "ok") {
    return page(
      "You're unsubscribed",
      "APEX won't email you session reminders any more. You can switch them back on from your account at any time.",
      200
    );
  }
  if (result === "unavailable") {
    return page("Try again later", "Reminders can't be changed right now.", 503);
  }
  return page(
    "This link isn't valid",
    "It may have been copied incompletely. You can turn reminders off from your account instead.",
    400
  );
}

export async function POST(request: Request) {
  const result = await unsubscribe(request);
  const status = result === "ok" ? 200 : result === "invalid" ? 400 : 503;
  return new Response(result, { status, headers: { "Content-Type": "text/plain", ...NO_STORE } });
}

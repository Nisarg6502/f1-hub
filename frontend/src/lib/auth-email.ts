/**
 * The magic-link email: what it says, and how it is (or is not) sent.
 *
 * Two hard rules shape this file.
 *
 * 1. DEVELOPMENT NEVER SENDS REAL EMAIL. Outside production the link is
 *    printed to the server console and nothing touches SMTP, even if SMTP
 *    variables happen to be present in `.env.local`. A test run that signs in
 *    `someone@example.com` must not mail a stranger, and a developer testing
 *    sign-in twenty times must not burn through a Gmail app password's daily
 *    sending allowance (Gmail suspends the account, not just the app
 *    password). The console link is how sign-in is tested end to end locally.
 *
 * 2. DELIVERY IS PLAIN SMTP, provider-agnostic. `EMAIL_SERVER_HOST/PORT/
 *    USER/PASSWORD` and `EMAIL_FROM` work with a Gmail app password today and
 *    any relay (Resend's SMTP endpoint, Postmark, SES) later, with no code
 *    change. Resend's HTTP API was the obvious alternative and was rejected
 *    as the DEFAULT: without a verified sending domain it will only deliver
 *    to the Resend account owner's own address, which would make sign-in work
 *    for exactly one person. SMTP keeps every option open.
 *
 * The templates are plain HTML tables with inline styles, because that is
 * the only CSS every mail client renders, and they always ship with a text
 * part: some clients show only text, and spam filters score HTML-only mail
 * down.
 */

export interface MagicLinkEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMagicLinkEmail({
  url,
  email,
  expiresInMinutes,
  siteUrl,
}: {
  url: string;
  email: string;
  expiresInMinutes: number;
  siteUrl: string;
}): MagicLinkEmail {
  const host = (() => {
    try {
      return new URL(siteUrl).host;
    } catch {
      return siteUrl;
    }
  })();
  const minutes = `${expiresInMinutes} minute${expiresInMinutes === 1 ? "" : "s"}`;

  const subject = "Your APEX sign-in link";

  // The text part carries the same facts as the HTML, in the same order:
  // what this is, the link, how long it lasts, that it works once, and what
  // to do if you did not ask for it.
  const text = [
    "Sign in to APEX",
    "",
    `Use this link to sign in as ${email}:`,
    "",
    url,
    "",
    `The link expires in ${minutes} and works once. If it has expired, request a new one from the sign-in page.`,
    "",
    "If you did not ask to sign in, ignore this email — nobody can sign in without the link, and no account changes until it is used.",
    "",
    `APEX · ${host}`,
    "An unofficial Formula 1 season hub. Not affiliated with Formula 1.",
  ].join("\n");

  const safeUrl = escapeHtml(url);
  const safeEmail = escapeHtml(email);
  const safeHost = escapeHtml(host);

  // Colours are the APEX tokens written out literally (mail clients have no
  // custom properties): #0a0908 background, #f6f1ea ink, #ff5a1f flame,
  // #a89e90 secondary text.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#0a0908;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0908;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#1a1613;border:1px solid #2a231d;border-radius:16px;">
<tr><td style="padding:28px 28px 8px 28px;font-family:Helvetica,Arial,sans-serif;">
<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#ff5a1f;vertical-align:middle;"></span>
<span style="font-size:20px;font-weight:800;letter-spacing:-0.5px;color:#f6f1ea;vertical-align:middle;margin-left:8px;">APEX</span>
</td></tr>
<tr><td style="padding:12px 28px 0 28px;font-family:Helvetica,Arial,sans-serif;color:#f6f1ea;">
<h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;font-weight:700;">Sign in to APEX</h1>
<p style="margin:0 0 24px 0;font-size:15px;line-height:1.55;color:#c9c0b4;">Use the button below to sign in as <strong style="color:#f6f1ea;">${safeEmail}</strong>.</p>
</td></tr>
<tr><td style="padding:0 28px;">
<a href="${safeUrl}" style="display:inline-block;background:#ff5a1f;color:#1a1210;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:12px;">Sign in</a>
</td></tr>
<tr><td style="padding:24px 28px 0 28px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.55;color:#a89e90;">
<p style="margin:0 0 12px 0;">The link expires in <strong style="color:#f6f1ea;">${minutes}</strong> and works once. If it has expired, request a new one from the sign-in page.</p>
<p style="margin:0 0 12px 0;">Button not working? Paste this into your browser:<br><a href="${safeUrl}" style="color:#ffae6a;word-break:break-all;">${safeUrl}</a></p>
<p style="margin:0;">If you did not ask to sign in, ignore this email. Nobody can sign in without the link, and nothing changes until it is used.</p>
</td></tr>
<tr><td style="padding:24px 28px 28px 28px;font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.5;color:#877e72;border-top:1px solid #2a231d;">
APEX · ${safeHost}<br>An unofficial Formula 1 season hub. Not affiliated with Formula 1.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  from: string;
}

/**
 * Read SMTP settings from the environment. `null` when the minimum (a host
 * and a From address) is missing, which the caller treats as "email sign-in
 * cannot send" rather than guessing at defaults.
 */
export function readSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.EMAIL_SERVER_HOST;
  const from = env.EMAIL_FROM;
  if (!host || !from) return null;
  const port = Number(env.EMAIL_SERVER_PORT ?? 587);
  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    user: env.EMAIL_SERVER_USER || undefined,
    password: env.EMAIL_SERVER_PASSWORD || undefined,
    from,
  };
}

/**
 * Whether this process should really send mail. Production only; see rule 1
 * at the top of the file. `AUTH_EMAIL_TRANSPORT=console` forces console mode
 * in a production build too, which is how the headless end-to-end run signs
 * in against `next start` without mailing anyone.
 */
export function shouldSendRealEmail(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AUTH_EMAIL_TRANSPORT === "console") return false;
  return env.NODE_ENV === "production";
}

export async function deliverMagicLink(
  email: string,
  message: MagicLinkEmail,
  url: string
): Promise<void> {
  if (!shouldSendRealEmail()) {
    // The link is a bearer credential, and this branch exists precisely to
    // print it — which is acceptable only because it never runs where real
    // users sign in.
    console.info(
      `\n[auth] Magic link for ${email} (not emailed: development transport)\n${url}\n`
    );
    return;
  }

  const smtp = readSmtpConfig();
  if (!smtp) {
    // Loud in the logs, generic to the visitor: the sign-in form shows its
    // standard "could not send" error.
    throw new Error("Email sign-in is not configured (EMAIL_SERVER_HOST / EMAIL_FROM)");
  }

  // Imported lazily so the SMTP client is never loaded into a build or a
  // route that does not send mail.
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    // 465 is implicit TLS; 587 and 25 upgrade with STARTTLS.
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
  });

  await transport.sendMail({
    from: smtp.from,
    to: email,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

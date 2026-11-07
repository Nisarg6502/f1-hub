import "server-only";
import { readSmtpConfig, shouldSendRealEmail } from "./auth-email";
import type { ReminderMailer } from "./reminders";

/**
 * The reminder mailer: the same SMTP account and the same rules as the
 * magic-link mail in `auth-email.ts` — real mail in production only, and the
 * console everywhere else (or with `AUTH_EMAIL_TRANSPORT=console`).
 *
 * `REMINDERS_EMAIL_ALLOWLIST` (comma-separated addresses), when set, refuses
 * real delivery to anyone not on it. It exists for exercising the full
 * production path against real data without mailing real subscribers; it is
 * unset in production.
 */
export async function createReminderMailer(env: NodeJS.ProcessEnv = process.env): Promise<ReminderMailer> {
  const allow = (env.REMINDERS_EMAIL_ALLOWLIST ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  const allowed = (to: string) => allow.length === 0 || allow.includes(to.trim().toLowerCase());

  if (!shouldSendRealEmail(env)) {
    return {
      async send(message) {
        console.info(
          `[reminders] (console transport, not emailed) to=${message.to} subject=${JSON.stringify(message.subject)}`
        );
      },
    };
  }

  const smtp = readSmtpConfig(env);
  if (!smtp) throw new Error("Reminder email is not configured (EMAIL_SERVER_HOST / EMAIL_FROM)");
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
  });

  return {
    async send(message) {
      if (!allowed(message.to)) throw new Error("Recipient not in REMINDERS_EMAIL_ALLOWLIST");
      await transport.sendMail({
        from: smtp.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.headers,
      });
    },
  };
}

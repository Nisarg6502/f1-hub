"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CALENDAR_SESSION_TYPES,
  SESSION_TYPE_LABELS,
  type CalendarSessionType,
} from "@/lib/race-calendar";
import { LEAD_OPTIONS, leadLabel, type LeadMinutes, type ReminderSettings } from "@/lib/reminder-settings";

/**
 * Email reminders on `/account`: on/off, which session types, how far ahead.
 * Saves on every change, like the rest of the page. The browser's time zone
 * is sent with each save so the email can show the session in local time as
 * well as UTC.
 */

type Status = "loading" | "ready" | "error";
type SaveState = "idle" | "saving" | "saved" | "failed";

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const chipClass = (on: boolean) =>
  `min-h-[44px] px-3.5 flex items-center justify-center rounded-xl border text-[13px] font-semibold cursor-pointer transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary ${
    on
      ? "border-primary/60 bg-primary-container/15 text-on-background"
      : "border-white/[0.12] text-warm-300 hover:bg-white/[0.04]"
  }`;

export default function RemindersSection({ email }: { email: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/reminders", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { reminders: ReminderSettings }) => {
        if (cancelled) return;
        setSettings(body.reminders);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function update(next: ReminderSettings) {
    const previous = settings;
    setSettings(next);
    setError(null);
    setSave("saving");
    try {
      const res = await fetch("/api/me/reminders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: next.enabled,
          sessionTypes: next.sessionTypes,
          leadMinutes: next.leadMinutes,
          timeZone: browserTimeZone() ?? null,
        }),
      });
      const body = (await res.json()) as { reminders?: ReminderSettings; message?: string };
      if (!res.ok || !body.reminders) throw new Error(body.message ?? "save failed");
      setSettings(body.reminders);
      setSave("saved");
    } catch (err) {
      setSettings(previous);
      setSave("failed");
      setError(err instanceof Error && err.message !== "save failed" ? err.message : null);
    }
  }

  function toggleType(type: CalendarSessionType) {
    if (!settings) return;
    const has = settings.sessionTypes.includes(type);
    const sessionTypes = has
      ? settings.sessionTypes.filter((t) => t !== type)
      : CALENDAR_SESSION_TYPES.filter((t) => t === type || settings.sessionTypes.includes(t));
    if (settings.enabled && sessionTypes.length === 0) {
      setError("Keep at least one session type, or switch reminders off.");
      return;
    }
    void update({ ...settings, sessionTypes });
  }

  const saveText =
    save === "saving" ? "Saving…" : save === "saved" ? "Saved" : save === "failed" ? "Couldn't save — try again" : "";

  return (
    <section id="reminders" className="apex-glass-soft rounded-2xl p-5 sm:p-6 scroll-mt-24">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="font-[family-name:var(--font-headline)] font-bold text-lg text-on-background">
            Session reminders
          </h2>
          <p className="text-[13px] text-warm-400 leading-relaxed mt-1">
            An email to <span className="text-warm-200">{email}</span> before the sessions you
            pick. Reminders never mention results.
          </p>
        </div>
        <span
          aria-live="polite"
          className={`text-xs font-medium ${save === "failed" ? "text-error" : "text-warm-400"}`}
        >
          {saveText}
        </span>
      </div>

      {status === "loading" && <p className="text-sm text-warm-400">Loading…</p>}
      {status === "error" && (
        <p className="text-sm text-error">Your reminder settings couldn&apos;t be loaded. Refresh to try again.</p>
      )}

      {status === "ready" && settings && (
        <div className="flex flex-col gap-5">
          <label className="flex items-center justify-between gap-4 rounded-xl border border-white/[0.08] px-4 py-3 cursor-pointer">
            <span>
              <span className="block text-sm font-semibold text-on-background">Email me before sessions</span>
              <span className="block text-xs text-warm-400">
                {settings.enabled ? "On" : "Off"} · one email per session
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={settings.enabled}
              disabled={save === "saving"}
              onChange={(event) => {
                const enabled = event.target.checked;
                const sessionTypes =
                  enabled && settings.sessionTypes.length === 0 ? (["race"] as CalendarSessionType[]) : settings.sessionTypes;
                void update({ ...settings, enabled, sessionTypes });
              }}
              className="w-5 h-5 accent-[var(--color-primary-container)]"
            />
          </label>

          <fieldset disabled={!settings.enabled || save === "saving"} className="disabled:opacity-50">
            <legend className="text-xs font-semibold text-warm-300 mb-2">Sessions</legend>
            <div className="flex flex-wrap gap-2">
              {CALENDAR_SESSION_TYPES.map((type) => {
                const on = settings.sessionTypes.includes(type);
                return (
                  <label key={type} className={chipClass(on)}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleType(type)}
                      className="sr-only"
                    />
                    {SESSION_TYPE_LABELS[type]}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset disabled={!settings.enabled || save === "saving"} className="disabled:opacity-50">
            <legend className="text-xs font-semibold text-warm-300 mb-2">How far ahead</legend>
            <div role="radiogroup" className="flex flex-wrap gap-2">
              {LEAD_OPTIONS.map((lead) => (
                <label key={lead} className={chipClass(settings.leadMinutes === lead)}>
                  <input
                    type="radio"
                    name="reminder-lead"
                    value={lead}
                    checked={settings.leadMinutes === lead}
                    onChange={() => update({ ...settings, leadMinutes: lead as LeadMinutes })}
                    className="sr-only"
                  />
                  {leadLabel(lead)}
                </label>
              ))}
            </div>
          </fieldset>

          {error && (
            <p role="alert" className="text-xs text-error">
              {error}
            </p>
          )}
          <p className="text-xs text-warm-400 leading-relaxed">
            Times are shown in UTC and in your time zone
            {settings.timeZone ? ` (${settings.timeZone})` : ""}. Every email has a one-click
            unsubscribe link. Prefer your calendar app? Subscribe from the{" "}
            <Link href="/schedule" className="underline hover:text-warm-200">race calendar</Link>.
          </p>
        </div>
      )}
    </section>
  );
}

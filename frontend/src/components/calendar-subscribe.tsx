"use client";

import { useId, useState } from "react";
import {
  CALENDAR_SESSION_TYPES,
  DEFAULT_SESSION_TYPES,
  SESSION_TYPE_LABELS,
  feedLinks,
  type CalendarSessionType,
} from "@/lib/race-calendar";

/**
 * "Add to calendar" for the season's sessions: pick the session types, then
 * subscribe (webcal:// for Apple Calendar / Outlook, or Google Calendar) or
 * download a one-off .ics. A subscription follows schedule changes; a
 * download is a snapshot, which the copy says.
 *
 * `origin` comes from the server so the links are right on first render (no
 * hydration flip from a `window.location` read).
 */
export default function CalendarSubscribe({ origin, season }: { origin: string; season: number }) {
  const [types, setTypes] = useState<CalendarSessionType[]>(DEFAULT_SESSION_TYPES);
  const [copied, setCopied] = useState(false);
  const headingId = useId();
  const links = feedLinks(origin, types);
  const empty = types.length === 0;

  function toggle(type: CalendarSessionType) {
    setCopied(false);
    setTypes((current) =>
      current.includes(type)
        ? current.filter((t) => t !== type)
        : CALENDAR_SESSION_TYPES.filter((t) => t === type || current.includes(t))
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(links.https);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const action =
    "min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl border text-xs font-semibold transition aria-disabled:opacity-40 aria-disabled:pointer-events-none";

  return (
    <section aria-labelledby={headingId} className="apex-glass-soft rounded-card p-[18px]">
      <h2 id={headingId} className="flex items-center gap-2 font-bold text-[11px] tracking-[0.12em] uppercase text-flame">
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
          calendar_add_on
        </span>
        Add to calendar
      </h2>
      <p className="text-xs text-warm-400 leading-relaxed mt-2 mb-3">
        Every {season} session in your own calendar, in your time zone, with an
        alert 30 minutes before. Subscribed calendars update when times change.
      </p>
      <fieldset>
        <legend className="sr-only">Sessions to include</legend>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {CALENDAR_SESSION_TYPES.map((type) => {
            const on = types.includes(type);
            return (
              <label
                key={type}
                className={`min-h-[32px] px-2.5 inline-flex items-center rounded-lg border text-[11px] font-semibold cursor-pointer transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary ${
                  on
                    ? "border-primary/60 bg-primary-container/15 text-on-background"
                    : "border-white/[0.12] text-warm-400 hover:bg-white/[0.04]"
                }`}
              >
                <input type="checkbox" checked={on} onChange={() => toggle(type)} className="sr-only" />
                {SESSION_TYPE_LABELS[type]}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="grid grid-cols-1 gap-2">
        <a
          href={links.webcal}
          aria-disabled={empty}
          className={`${action} border-primary/50 bg-primary-container/15 text-on-background hover:bg-primary-container/25`}
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">event_repeat</span>
          Subscribe (Apple, Outlook)
        </a>
        <a
          href={links.google}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={empty}
          className={`${action} border-white/[0.14] text-warm-100 hover:bg-white/[0.05]`}
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">calendar_month</span>
          Google Calendar
        </a>
        <div className="grid grid-cols-2 gap-2">
          <a
            href={links.download}
            download
            aria-disabled={empty}
            className={`${action} border-white/[0.14] text-warm-100 hover:bg-white/[0.05]`}
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">download</span>
            .ics file
          </a>
          <button
            type="button"
            onClick={copy}
            disabled={empty}
            className={`${action} border-white/[0.14] text-warm-100 hover:bg-white/[0.05] disabled:opacity-40`}
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              {copied ? "check" : "link"}
            </span>
            <span aria-live="polite">{copied ? "Copied" : "Copy link"}</span>
          </button>
        </div>
      </div>
      {empty && <p className="text-[11px] text-error mt-2">Pick at least one session type.</p>}
    </section>
  );
}

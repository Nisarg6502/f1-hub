"use client";

import CountdownTimer from "@/components/countdown-timer";
import HeroFX from "@/components/hero-fx";
import LocalDateTime from "@/components/local-datetime";
import TiltCard from "@/components/tilt-card";
import { SeasonCard } from "./season-widget";
import { Kicker, pad2, raceStartMs, useCountdown, type WidgetProps } from "../widget-kit";
import type { HomeData } from "../home-data";

const SESSION_TIME = {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
} as const;

function heroNames(data: HomeData) {
  const raceName = data.nextRace?.raceName ?? "Next Grand Prix";
  const base = raceName.replace(" Grand Prix", "");
  return { raceName, base, hasGP: base !== raceName };
}

/**
 * The countdown to the next race, at four sizes.
 *
 * `full` is the old home page's hero, unchanged: the race name as the page's
 * `h1`, the ticking countdown, the next sessions, and the season card beside
 * it. The smaller sizes are separate designs, not that hero shrunk — at `l`
 * the countdown keeps its sessions, at `m` it is the name and the four digits,
 * at `s` it is the single number a glance wants: how many days.
 */
export default function CountdownWidget({ data, size }: WidgetProps) {
  if (size === "full") return <CountdownHero data={data} />;
  return <CountdownCard data={data} size={size} />;
}

function CountdownHero({ data }: { data: HomeData }) {
  const { base, hasGP } = heroNames(data);
  const { nextRace, seasonYear, upcomingSessions } = data;
  const locality = nextRace?.Circuit?.Location?.locality;
  const circuit = nextRace?.Circuit?.circuitName;

  return (
    /* Bleeds into the grid's gutter (-mx / matching px) so the ember backdrop
       and the cursor spotlight span the page edge to edge as they always did,
       while the text stays on the same left edge as every other widget.
       `min-h-[500px]` + the grid's 20px gap reproduces the old 520px hero. */
    <section className="relative overflow-hidden -mx-6 md:-mx-10 px-6 md:px-10 pt-12 pb-6 min-h-[500px]">
      <HeroFX />
      <div className="relative grid lg:grid-cols-[1.4fr_0.78fr] gap-10 lg:gap-[52px] items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-[13px] mb-6 anim-rise">
            <span className="font-bold text-xs tracking-[0.16em] uppercase text-flame">
              {nextRace ? `Round ${nextRace.round}` : `Season ${seasonYear}`}
            </span>
            {(locality || circuit) && (
              <>
                <span className="w-[5px] h-[5px] rounded-full bg-warm-700" />
                <span className="font-semibold text-xs tracking-[0.1em] uppercase text-warm-400">
                  {[locality, circuit].filter(Boolean).join(" · ")}
                </span>
              </>
            )}
          </div>

          {/* An `h1`, not two styled divs. The 80px race name is the most
              obvious title on the site and carried no heading semantics at
              all — `querySelectorAll('h1,h2,h3')` returned empty on this
              page. The inner elements become spans because a `div` inside an
              `h1` is invalid; `block` keeps them on their own lines, so
              nothing moves visually. Only this size renders it, and the
              countdown is a unique widget, so the page never has two. */}
          <h1 className="leading-[0.94] mb-3">
            <span className="block font-[family-name:var(--font-headline)] font-bold text-5xl sm:text-6xl md:text-[80px] tracking-[-2px] anim-fade">
              {base}
            </span>
            {hasGP && (
              <span
                className="block font-[family-name:var(--font-headline)] font-extrabold text-5xl sm:text-6xl md:text-[80px] tracking-[-2px] apex-flame-text anim-fade"
                style={{ animationDelay: "0.12s" }}
              >
                Grand Prix
              </span>
            )}
          </h1>

          <div
            className="h-[2px] w-[130px] bg-[linear-gradient(90deg,var(--color-primary-container),transparent)] anim-line mb-8"
            style={{ animationDelay: "0.5s" }}
          />

          <div className="mb-6 anim-rise" style={{ animationDelay: "0.35s" }}>
            <CountdownTimer targetRace={nextRace ?? undefined} />
          </div>

          {upcomingSessions.length > 0 && (
            <div className="flex flex-wrap items-center gap-4 anim-rise" style={{ animationDelay: "0.5s" }}>
              {/* The qualifier sits on the label, once, rather than inside
                  each chip — four repetitions of one fact that applies to all
                  of them is four times the noise. */}
              <span className="font-semibold text-[13px] text-warm-300">
                Next session
                <span className="block font-medium text-[11px] text-warm-500">your local time</span>
              </span>
              <SessionChips sessions={upcomingSessions} />
            </div>
          )}
        </div>

        <TiltCard
          className="apex-glass apex-sheen rounded-panel p-7 anim-rise min-w-0 overflow-hidden"
          strength={5}
        >
          <SeasonCard data={data} />
        </TiltCard>
      </div>
    </section>
  );
}

function SessionChips({ sessions, max = 4 }: { sessions: HomeData["upcomingSessions"]; max?: number }) {
  return (
    <div className="flex flex-wrap gap-2">
      {sessions.slice(0, max).map((s, i) => (
        <span
          key={s.id}
          className={`text-xs px-[14px] py-2 rounded-control whitespace-nowrap ${
            i === 0 ? "font-bold bg-primary-container/16 text-primary" : "font-semibold bg-veil/5 text-warm-200"
          }`}
        >
          {s.sessionLabel} · <LocalDateTime timestampMs={s.startTimeMs} options={SESSION_TIME} />
        </span>
      ))}
    </div>
  );
}

function CountdownCard({ data, size }: { data: HomeData; size: "s" | "m" | "l" }) {
  const { base, hasGP } = heroNames(data);
  const { nextRace, seasonYear, upcomingSessions } = data;
  const target = raceStartMs(nextRace?.date, nextRace?.time);
  const t = useCountdown(target);
  const locality = nextRace?.Circuit?.Location?.locality;
  const kicker = nextRace ? `Round ${nextRace.round}${size !== "s" && locality ? ` · ${locality}` : ""}` : `Season ${seasonYear}`;

  const segments = t
    ? [
        { label: "Days", short: "d", value: pad2(t.days) },
        { label: "Hours", short: "h", value: pad2(t.hours) },
        { label: "Min", short: "m", value: pad2(t.minutes) },
        { label: "Sec", short: "s", value: pad2(t.seconds), hot: true },
      ]
    : [];

  return (
    <div className="apex-glass apex-sheen rounded-panel overflow-hidden h-full p-5 lg:p-[26px] flex flex-col">
      <Kicker>{kicker}</Kicker>
      <div
        className={`relative font-[family-name:var(--font-headline)] font-bold leading-[1.02] tracking-[-0.02em] mt-2.5 ${
          size === "l" ? "text-[40px]" : size === "m" ? "text-[26px] truncate" : "text-[20px] line-clamp-2"
        }`}
      >
        {base}
        {hasGP && size === "l" && <span className="block apex-flame-text font-extrabold">Grand Prix</span>}
      </div>

      <div className="relative mt-auto">
        {!t ? (
          <div className="font-[family-name:var(--font-headline)] text-xl font-bold text-warm-400">
            Awaiting schedule
          </div>
        ) : size === "s" ? (
          /* One number. A day count is what a glance at a small tile wants;
             the full clock is a size up. */
          <div>
            <div className="flex items-baseline gap-1.5">
              <span suppressHydrationWarning className="font-extrabold text-[44px] leading-none tabular-nums">
                {t.days}
              </span>
              <span className="font-semibold text-[11px] tracking-[0.08em] uppercase text-warm-500">
                {t.days === 1 ? "day" : "days"}
              </span>
            </div>
            <div suppressHydrationWarning className="mt-1.5 font-semibold text-[12px] tabular-nums text-warm-300">
              {pad2(t.hours)}h {pad2(t.minutes)}m <span className="text-flame">{pad2(t.seconds)}s</span>
            </div>
          </div>
        ) : (
          <div className="flex items-stretch">
            {segments.map((seg, i) => (
              <div key={seg.label} className="flex items-stretch">
                <div className={i === 0 ? "pr-3 lg:pr-4" : "px-3 lg:px-4"}>
                  <div
                    suppressHydrationWarning
                    className={`font-extrabold leading-none tabular-nums ${
                      size === "l" ? "text-[44px]" : "text-[32px]"
                    } ${seg.hot ? "text-flame" : "text-on-background"}`}
                  >
                    {seg.value}
                  </div>
                  <div
                    className={`mt-[5px] text-[10px] font-semibold tracking-[0.12em] uppercase ${
                      seg.hot ? "text-[#8a6a52]" : "text-warm-500"
                    }`}
                  >
                    {seg.label}
                  </div>
                </div>
                {i < segments.length - 1 && <div className="w-px bg-veil/10" />}
              </div>
            ))}
          </div>
        )}
        {size === "l" && t && (
          <>
            {target !== null && (
              <div className="mt-3 text-xs font-semibold text-warm-400">
                <LocalDateTime
                  timestampMs={target}
                  options={{ weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }}
                />{" "}
                · your local time
              </div>
            )}
            {upcomingSessions.length > 0 && (
              <div className="mt-5">
                <div className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500 mb-2">
                  Next sessions · your local time
                </div>
                <SessionChips sessions={upcomingSessions} max={3} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import DiscoveryTips from "@/components/discovery-tips";
import { Reveal, Stagger, StaggerItem } from "@/components/motion-primitives";
import { OPEN_PITWALL_EVENT } from "@/components/pitwall-assistant-launcher";
import { Kicker, type WidgetProps } from "../widget-kit";

/* ---------------------------------- explore ---------------------------------- */

/**
 * "Explore the season": the four link tiles. `full` is the old section as it
 * was (heading, then four across from `lg`); `l` stacks them two by two to
 * fill a 2×2 cell.
 *
 * `pt-5` on the full size is the old page's spacing restored: the section used
 * to sit 40px below the bento (`pt-10`); the grid's own 20px gap supplies half.
 */
export function ExploreWidget({ data, size }: WidgetProps) {
  const tiles = [
    { href: "/schedule", kicker: "Race calendar", big: `${data.season.total || 22}`, small: "races" },
    { href: "/standings", kicker: "Championship", title: "Standings" },
    { href: "/drivers", kicker: "Driver grid", big: `${data.driverCount || 22}`, small: "drivers" },
    { href: "/teams", kicker: "Constructors", title: "Teams", accent: true },
  ];
  const full = size === "full";
  return (
    <section className={full ? "pt-5" : "h-full flex flex-col"}>
      <Reveal className={`flex items-baseline justify-between ${full ? "mb-5" : "mb-3"}`}>
        <span className={`font-[family-name:var(--font-headline)] font-bold ${full ? "text-[20px]" : "text-[18px]"}`}>
          Explore the season
        </span>
      </Reveal>
      <Stagger
        className={full ? "grid grid-cols-2 lg:grid-cols-4 gap-4" : "flex-1 min-h-0 grid grid-cols-2 grid-rows-2 gap-3"}
        gap={0.06}
      >
        {tiles.map((c) => (
          <StaggerItem key={c.href} className={full ? undefined : "min-h-0"}>
            <Link
              href={c.href}
              className="apex-glass-soft rounded-2xl p-[22px] flex flex-col gap-[14px] h-full transition-[transform,border-color] duration-200 hover:-translate-y-1 hover:border-flame-bright/45"
            >
              <span className="font-semibold text-[11px] tracking-[0.12em] uppercase text-warm-400">{c.kicker}</span>
              {c.big ? (
                <span className="font-extrabold text-2xl tabular-nums">
                  {c.big} <span className="text-[15px] font-semibold text-warm-300">{c.small}</span>
                </span>
              ) : (
                <span
                  className={`font-[family-name:var(--font-headline)] font-bold text-xl ${c.accent ? "text-primary" : ""}`}
                >
                  {c.title}
                </span>
              )}
            </Link>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}

/* ------------------------------------ tips ------------------------------------ */

/**
 * One rotating pointer into the surfaces the explore tiles don't reach — the
 * 3D viewer, the Pitwall, the replay, the barcode. Seeded from the round
 * number so the server and client agree on tip #1.
 *
 * The rail brings its own `mt-4` from when it sat directly under the explore
 * tiles; as a widget the grid owns the spacing, so it is zeroed here rather
 * than by editing a component other pages may yet use. At `m` the rail fills
 * its cell and centres its content.
 */
export function TipsWidget({ data, size }: WidgetProps) {
  return (
    <div
      className={
        size === "m"
          ? "h-full [&>div]:mt-0 [&>div]:h-full [&>div]:content-center"
          : "[&>div]:mt-0"
      }
    >
      <DiscoveryTips
        seasonYear={data.seasonYear}
        latestCompletedRound={data.lastRace?.round ?? null}
        seed={Number(data.nextRace?.round ?? 0) || 0}
      />
    </div>
  );
}

/* --------------------------------- race week --------------------------------- */

/**
 * The race-week strip is an async server component that fetches the weekend's
 * sessions itself, so the client grid cannot render it — the page renders it
 * once on the server and hands the result in as a slot.
 *
 * Between weekends that slot is empty. Outside edit mode the cell then
 * collapses to nothing, exactly as the old page let the bento move up; in
 * edit mode and in the gallery it becomes this placeholder instead, because a
 * zero-height widget can be neither seen, grabbed nor removed.
 *
 * The strip's own outer spacing (`px`, `mt-2 mb-9`) belonged to the old page's
 * flow. The horizontal padding is dropped (the grid supplies the gutter) and
 * the vertical spacing is re-expressed against the grid's 20px gap so the
 * strip sits exactly where it used to.
 */
export function RaceWeekWidget({ data, slots, preview, editing }: WidgetProps) {
  if (data.raceWeekActive) {
    return (
      <div className="pt-2 pb-4 [&>section]:px-0 [&>section]:mt-0 [&>section]:mb-0">{slots.raceWeek}</div>
    );
  }
  if (!editing && !preview) return null;
  return (
    <div className="rounded-tile border border-dashed border-veil/15 bg-veil/[0.025] px-5 py-5 flex flex-wrap items-center gap-x-3 gap-y-1">
      <Kicker>Race week</Kicker>
      <span className="font-medium text-[12px] text-warm-400">
        Appears during race weekends — the latest session&apos;s top three, linked to the full results.
      </span>
    </div>
  );
}

/* -------------------------------- ask the pitwall -------------------------------- */

const openPitwall = () => window.dispatchEvent(new Event(OPEN_PITWALL_EVENT));

/**
 * A front door to the Pitwall Assistant. It does not embed the assistant — the
 * launcher in the nav owns that panel, its open/minimised state and its
 * conversation — it just asks the launcher to open, the same way the nav
 * button and Cmd/Ctrl+K do.
 *
 * The example question at `m` is an example, not a button: the launcher has no
 * way to be handed a question, and a chip that looked like it would ask one
 * and then opened an empty panel would be a small lie.
 */
export function AskPitwallWidget({ size, preview }: WidgetProps) {
  return (
    <button
      type="button"
      onClick={preview ? undefined : openPitwall}
      className="group apex-glass apex-sheen rounded-panel overflow-hidden h-full w-full p-5 lg:p-[26px] text-left flex flex-col transition-transform duration-150 active:scale-[0.98]"
    >
      <span className="relative flex items-center justify-between w-full">
        <Kicker>Ask the Pitwall</Kicker>
        <span
          className="material-symbols-outlined text-[22px] text-flame transition-transform duration-200 group-hover:-translate-y-0.5"
          aria-hidden="true"
        >
          forum
        </span>
      </span>
      <span className="relative mt-3 font-[family-name:var(--font-headline)] font-bold text-[20px] leading-[1.1]">
        {size === "s" ? "Ask anything about F1" : "Ask anything about any race, driver or season"}
      </span>
      {size === "m" && (
        <span className="relative mt-2 font-medium text-[12px] text-warm-400">
          e.g. &ldquo;Who has the most wins this season?&rdquo; — answers come with their sources.
        </span>
      )}
      <span className="relative mt-auto flex items-center gap-2 pt-3">
        <span className="inline-flex items-center gap-1.5 rounded-control bg-primary-container/16 px-3 py-2 font-bold text-[12px] text-primary">
          Open assistant
          <span className="material-symbols-outlined text-[15px] leading-none" aria-hidden="true">
            arrow_forward
          </span>
        </span>
        <kbd className="hidden lg:inline font-semibold text-[10px] text-warm-500 border border-veil/10 rounded px-1.5 py-0.5">
          ⌘/Ctrl K
        </kbd>
      </span>
    </button>
  );
}

import type { CSSProperties, ReactNode } from "react";
import { joinNames } from "@/lib/spoilers";
import SpoilerRevealButton from "./spoiler-reveal-button";

/**
 * Where a hidden result would have been.
 *
 * Not a blur, not a `display: none`, not an overlay: when `hidden` is true the
 * children are simply not rendered. Blurred text is still text — Ctrl+F finds
 * it, a screen reader reads it aloud, a copy-paste carries it, and a slow
 * filter paints it sharp for a frame. A missing subtree has none of those
 * problems.
 *
 * Deliberately NOT a client component (no `"use client"`, no hooks), so it
 * renders on the server and a server page's `children` are never serialised
 * when they are not drawn. It works inside client components too; only the
 * reveal button is a client island.
 *
 * Calm on purpose. It is not an error and not an upsell: the visitor asked for
 * this, and the placeholder only has to say what is missing, why, and how to
 * get it back.
 */

type Names = string | string[];

function asList(value: Names): string[] {
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

export function hiddenTitle(raceName: Names): string {
  const names = asList(raceName);
  return names.length
    ? `Results from the ${joinNames(names)} are hidden`
    : "These results are hidden";
}

function EyeOffMark({ size = "md" }: { size?: "md" | "sm" }) {
  return (
    <span
      className={`flex-none rounded-tile bg-primary-container/10 border border-primary-container/25 flex items-center justify-center ${
        size === "sm" ? "w-9 h-9" : "w-14 h-14"
      }`}
      aria-hidden="true"
    >
      <span className={`material-symbols-outlined text-flame ${size === "sm" ? "text-[18px]" : "text-2xl"}`}>
        visibility_off
      </span>
    </span>
  );
}

export interface SpoilerShieldProps {
  hidden: boolean;
  /** The round(s) the reveal button marks as watched. */
  raceKey: string | string[];
  /** Full grand prix name(s), e.g. "Mexico City Grand Prix". */
  raceName: string | string[];
  /** Override the heading, e.g. "Standings include the … result". */
  title?: string;
  /** One line under the heading. */
  description?: ReactNode;
  /** Hold the footprint of what is missing, so the page does not collapse around it. */
  minHeight?: CSSProperties["minHeight"];
  className?: string;
  children?: ReactNode;
}

export default function SpoilerShield({
  hidden,
  raceKey,
  raceName,
  title,
  description,
  minHeight = 320,
  className = "",
  children,
}: SpoilerShieldProps) {
  if (!hidden) return <>{children}</>;

  const keys = asList(raceKey);
  const heading = title ?? hiddenTitle(raceName);

  return (
    <section
      aria-label="Hidden by spoiler-free mode"
      className={`apex-glass-soft rounded-2xl px-6 py-12 flex flex-col items-center justify-center text-center ${className}`}
      style={{ minHeight }}
    >
      <EyeOffMark />
      <p className="mt-5 font-bold text-[10px] tracking-[0.16em] uppercase text-flame">
        Spoiler-free mode
      </p>
      <h2 className="mt-2 font-[family-name:var(--font-headline)] font-bold text-xl md:text-2xl max-w-xl text-balance">
        {heading}
      </h2>
      <p className="mt-2 font-medium text-sm text-warm-400 max-w-md">
        {description ??
          "Watched it already? Reveal it and this page updates in place."}
      </p>
      <div className="mt-6">
        <SpoilerRevealButton
          raceKeys={keys}
          label={keys.length > 1 ? "I’ve watched them — show results" : undefined}
        />
      </div>
    </section>
  );
}

/**
 * A one-row version for the top of a page whose items each lose a figure (the
 * driver grid, the team cards): it explains once, with the button, so the
 * cards themselves can carry a quiet `SpoilerStub` instead of twenty buttons.
 */
export function SpoilerBanner({
  raceKey,
  raceName,
  title,
  description,
  className = "",
}: Omit<SpoilerShieldProps, "hidden" | "children" | "minHeight">) {
  const keys = asList(raceKey);
  return (
    <section
      aria-label="Hidden by spoiler-free mode"
      className={`apex-glass-soft rounded-2xl px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4 ${className}`}
    >
      <div className="flex items-start gap-3.5 min-w-0 flex-1">
        <EyeOffMark size="sm" />
        <div className="min-w-0">
          <p className="font-bold text-sm text-on-background">
            {title ?? hiddenTitle(raceName)}
          </p>
          <p className="font-medium text-xs text-warm-400 mt-0.5">
            {description ?? "Spoiler-free mode is on."}
          </p>
        </div>
      </div>
      <SpoilerRevealButton
        raceKeys={keys}
        size="sm"
        label={keys.length > 1 ? "I’ve watched them" : "I’ve watched it"}
      />
    </section>
  );
}

/**
 * The body of a small card (the home page's bento tiles) whose whole content
 * is a result. Keeps the card's own kicker so the grid still reads as the
 * same three cards, and carries its own reveal button because a bento tile
 * has no page banner above it to point at.
 */
export function SpoilerTile({
  kicker,
  raceKey,
  raceName,
  title,
}: {
  kicker: string;
  raceKey: string | string[];
  raceName: string | string[];
  title?: string;
}) {
  const keys = asList(raceKey);
  const names = asList(raceName);
  return (
    <div className="relative flex flex-col h-full" aria-label="Hidden by spoiler-free mode">
      <span className="font-bold text-[11px] tracking-[0.14em] uppercase text-warm-300">
        {kicker}
      </span>
      <div className="flex items-center gap-3 mt-4">
        <EyeOffMark size="sm" />
        <p className="font-bold text-sm text-on-background leading-snug">
          {title ?? `Hidden until you’ve watched the ${joinNames(names.map((n) => n.replace(/ Grand Prix$/, " GP")))}`}
        </p>
      </div>
      <p className="font-medium text-xs text-warm-400 mt-2">Spoiler-free mode is on.</p>
      <div className="mt-auto pt-4">
        <SpoilerRevealButton
          raceKeys={keys}
          size="sm"
          label={keys.length > 1 ? "I’ve watched them" : "I’ve watched it"}
        />
      </div>
    </div>
  );
}

/** An inline "hidden" marker for a figure inside a card or a list row. */
export function SpoilerStub({
  label = "Hidden",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-semibold text-[11px] text-warm-400 ${className}`}
    >
      <span className="material-symbols-outlined text-[15px] text-flame/80" aria-hidden="true">
        visibility_off
      </span>
      {label}
    </span>
  );
}

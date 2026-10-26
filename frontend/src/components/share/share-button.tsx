"use client";

import { useCallback, useState } from "react";
import { Share } from "lucide-react";
import {
  progressionCardPath,
  raceCardPath,
  shareFilename,
  standingsCardPath,
  type RaceSession,
  type ShareFormat,
  type ShareSurface,
  type StandingsKind,
} from "@/lib/share";
import ShareSheet, { type ShareRenderResult, type ShareSheetProps, type ShareVariant } from "./share-sheet";

/**
 * The Share icon button, and one ready-made wrapper per surface.
 *
 * The wrappers exist so each insertion on a page is a single line with the
 * page's own values (`<StandingsShareButton season={year} kind="drivers" />`)
 * and the knowledge of which route draws which card stays here, in one file,
 * rather than spread across four pages owned by four different features.
 *
 * The sheet is not mounted until the first click — nothing about sharing
 * costs a page anything until someone asks — and stays mounted afterwards so
 * its exit animation can play.
 */

type SheetSource = Omit<ShareSheetProps, "open" | "onClose">;

export function ShareButton({
  label,
  className = "",
  size = "md",
  ...source
}: SheetSource & { label: string; className?: string; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const dims = size === "sm" ? "h-7 w-7 before:-inset-1.5" : "h-[46px] w-[46px] before:-inset-0.5";
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
        data-share-open={source.surface}
        className={`relative flex flex-none items-center justify-center rounded-control text-warm-300 transition-[color,background-color,border-color,transform] duration-150 before:absolute before:content-[''] hover:text-on-background active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame-bright/60 ${
          size === "sm" ? "hover:bg-white/5" : "apex-glass-soft hover:border-flame-bright/50"
        } ${dims} ${className}`}
      >
        <Share size={size === "sm" ? 14 : 17} aria-hidden />
      </button>
      {mounted && <ShareSheet {...source} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Fetch a server-rendered card. Non-image answers (a 404 for a session with
 * no classification, a 503) arrive as JSON with an `error` string, which is
 * surfaced in the sheet as written — the routes word them for a reader.
 */
async function fetchCard(path: string): Promise<ShareRenderResult> {
  const res = await fetch(path);
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/png")) {
    let message = "The image could not be made right now.";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Not JSON — keep the generic message.
    }
    throw new Error(message);
  }
  return { blob: await res.blob() };
}

export function StandingsShareButton({ season, kind }: { season: number; kind: StandingsKind }) {
  const path = useCallback((format: ShareFormat) => standingsCardPath({ season, kind, format }), [season, kind]);
  const render = useCallback((format: ShareFormat) => fetchCard(path(format)), [path]);
  const filenameFor = useCallback(
    (format: ShareFormat) => shareFilename(["standings", season, kind], format),
    [season, kind]
  );
  return (
    <ShareButton
      label={`Share the ${season} ${kind === "drivers" ? "drivers'" : "constructors'"} standings as an image`}
      surface="standings"
      heading={`Share ${kind === "drivers" ? "drivers'" : "constructors'"} standings`}
      render={render}
      linkFor={path}
      filenameFor={filenameFor}
    />
  );
}

export function ProgressionShareButton({ season, kind }: { season: number; kind: StandingsKind }) {
  const path = useCallback((format: ShareFormat) => progressionCardPath({ season, kind, format }), [season, kind]);
  const render = useCallback((format: ShareFormat) => fetchCard(path(format)), [path]);
  const filenameFor = useCallback(
    (format: ShareFormat) => shareFilename(["title-race", season, kind], format),
    [season, kind]
  );
  return (
    <ShareButton
      size="sm"
      label="Share the championship progression chart as an image"
      surface="progression"
      heading="Share the title race"
      render={render}
      linkFor={path}
      filenameFor={filenameFor}
    />
  );
}

const asSession = (variant: string): RaceSession => (variant === "sprint" ? "sprint" : "race");

export function RaceShareButton({
  season,
  round,
  raceName,
  sessions,
}: {
  season: number;
  round: number;
  raceName: string;
  /** Sessions with a classification. Only these are offered; the first is the default. */
  sessions: RaceSession[];
}) {
  const variants: ShareVariant[] = sessions.map((s) => ({ id: s, label: s === "sprint" ? "Sprint" : "Race" }));
  const path = useCallback(
    (format: ShareFormat, variant: string) => raceCardPath({ season, round, session: asSession(variant), format }),
    [season, round]
  );
  const render = useCallback((format: ShareFormat, variant: string) => fetchCard(path(format, variant)), [path]);
  const filenameFor = useCallback(
    (format: ShareFormat, variant: string) =>
      shareFilename([raceName, season, asSession(variant) === "sprint" ? "sprint" : null], format),
    [raceName, season]
  );
  if (sessions.length === 0) return null;
  return (
    <ShareButton
      label={`Share the ${season} ${raceName} result as an image`}
      surface="race"
      heading="Share the result"
      render={render}
      linkFor={path}
      filenameFor={filenameFor}
      variants={variants}
    />
  );
}

export type { ShareSurface };

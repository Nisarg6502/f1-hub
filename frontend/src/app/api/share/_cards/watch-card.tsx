import type { ShareFormat } from "@/lib/share";
import { C, CardFrame, HEAD } from "../_lib/frame";

export interface WatchCardProps {
  format: ShareFormat;
  season: number;
  round: number;
  raceName: string;
  circuitName: string | null;
  /** "Sun 8 Nov", or null when the calendar has no usable date. */
  dayLabel: string | null;
  host: string;
}

/**
 * The preview for a replay link.
 *
 * Shared with people who have not seen the race, so it carries the race, the
 * circuit and the day, and nothing about how it ended: no winner, no podium, no
 * portraits. The route that draws it never fetches results, so there is nothing
 * here to leak even by mistake.
 */
export function WatchCard({ format, season, round, raceName, circuitName, dayLabel, host }: WatchCardProps) {
  const landscape = format === "landscape";
  const gp = /\s*Grand Prix$/i.test(raceName);
  const title = gp ? raceName.replace(/\s*Grand Prix$/i, "") : raceName;
  const subtitle = [circuitName, dayLabel].filter(Boolean).join(" · ");

  return (
    <CardFrame
      format={format}
      eyebrow={`${season} · Round ${round}`}
      title={title}
      accent={gp ? "GP" : undefined}
      subtitle={subtitle || undefined}
      footnote="Replay of recorded laps · not live"
      host={host}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          flex: 1,
          gap: landscape ? 18 : 26,
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: HEAD,
            fontWeight: 800,
            fontSize: landscape ? 66 : 84,
            letterSpacing: -2,
            color: C.flameLight,
          }}
        >
          Watch it at race pace
        </div>
        <div
          style={{
            display: "flex",
            fontSize: landscape ? 30 : 40,
            fontWeight: 500,
            lineHeight: 1.3,
            color: C.sub,
          }}
        >
          Follow every lap as it happened. No results shown.
        </div>
      </div>
    </CardFrame>
  );
}

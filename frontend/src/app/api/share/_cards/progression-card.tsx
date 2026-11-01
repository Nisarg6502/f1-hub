import type { ShareFormat, StandingsKind } from "@/lib/share";
import type { ChartGeometry } from "@/lib/share-chart";
import { C, CardFrame, EmptyBody } from "../_lib/frame";

export interface ProgressionCardProps {
  format: ShareFormat;
  kind: StandingsKind;
  season: number;
  geometry: ChartGeometry | null;
  chartWidth: number;
  chartHeight: number;
  roundCount: number;
  shown: number;
  total: number;
  host: string;
}

/** Body box the chart is laid out into, per format. The route builds geometry for it. */
export function progressionChartBox(format: ShareFormat) {
  return format === "landscape"
    ? { width: 1088, height: 352, padLeft: 50, padRight: 128, padTop: 10, padBottom: 32 }
    : { width: 952, height: 950, padLeft: 58, padRight: 150, padTop: 14, padBottom: 44 };
}

/**
 * The championship-progression chart as a card.
 *
 * Lines and gridlines are inline SVG; every piece of text — axis ticks, round
 * names, end labels — is an absolutely positioned HTML element on top. That
 * split is forced: Satori rasterises inline `<svg>` through resvg, which does
 * not see the fonts handed to `ImageResponse`, so SVG `<text>` would fall
 * back to whatever resvg has (nothing on a slim container) while the HTML
 * text gets Hanken Grotesk like the rest of the card.
 */
export function ProgressionCard(props: ProgressionCardProps) {
  const { format, kind, season, geometry, chartWidth, chartHeight, roundCount, shown, total, host } = props;
  const landscape = format === "landscape";
  const label = kind === "drivers" ? "Drivers'" : "Constructors'";
  const subtitle = roundCount
    ? `Cumulative points, race and sprint · ${roundCount} round${roundCount === 1 ? "" : "s"}`
    : `${season} season`;
  // The page's own caveat, shortened: totals are summed from the rounds that
  // loaded, so a round whose results failed to fetch makes a line trail.
  const footnote = [shown < total ? `Top ${shown} of ${total}` : null, "Summed per round; can trail official totals"]
    .filter(Boolean)
    .join(" · ");

  if (!geometry) {
    return (
      <CardFrame
        format={format}
        eyebrow={`${season} · Progression`}
        title={`${season} ${label}`}
        accent="title race"
        subtitle={subtitle}
        footnote="No results on record yet"
        host={host}
      >
        <EmptyBody
          format={format}
          title="No rounds scored yet"
          detail={`The ${season} ${label.toLowerCase()} title race starts after the first race. There is nothing to chart yet.`}
        />
      </CardFrame>
    );
  }

  const tick = landscape ? 14 : 19;
  const endLabel = landscape ? 15 : 21;
  return (
    <CardFrame
      format={format}
      eyebrow={`${season} · ${roundCount} round${roundCount === 1 ? "" : "s"}`}
      title={`${season} ${label}`}
      accent="title race"
      subtitle={subtitle}
      footnote={footnote}
      host={host}
    >
      <div style={{ display: "flex", position: "relative", width: chartWidth, height: chartHeight }}>
        <svg width={chartWidth} height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`}>
          {geometry.yTicks.map((t) => (
            <line
              key={`g${t.value}`}
              x1={geometry.plot.left}
              x2={geometry.plot.right}
              y1={t.y}
              y2={t.y}
              stroke={C.grid}
              strokeWidth={1}
              strokeDasharray="4 5"
            />
          ))}
          {/* Back to front, so the leader's line is drawn last and sits on top. */}
          {[...geometry.paths].reverse().map((p) => (
            <path
              key={p.id}
              d={p.d}
              fill="none"
              stroke={p.colorHex}
              strokeWidth={landscape ? 3 : 4}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={p.dashed ? (landscape ? "8 6" : "11 8") : undefined}
            />
          ))}
          {geometry.paths.map((p) => (
            <circle key={`e${p.id}`} cx={p.endX} cy={p.endY} r={landscape ? 4.5 : 6} fill={p.colorHex} />
          ))}
        </svg>

        {geometry.yTicks.map((t) => (
          <div
            key={`y${t.value}`}
            style={{
              position: "absolute",
              left: 0,
              top: t.y - tick * 0.7,
              width: geometry.plot.left - 12,
              display: "flex",
              justifyContent: "flex-end",
              fontSize: tick,
              fontWeight: 500,
              color: C.dim,
            }}
          >
            {String(t.value)}
          </div>
        ))}

        {geometry.xLabels.map((l, i) => {
          const w = landscape ? 130 : 150;
          const first = i === 0;
          const last = i === geometry.xLabels.length - 1 && geometry.xLabels.length > 1;
          return (
            <div
              key={`x${l.x}`}
              style={{
                position: "absolute",
                top: geometry.plot.bottom + (landscape ? 10 : 14),
                left: first ? l.x - 4 : last ? l.x - w + 4 : l.x - w / 2,
                width: w,
                display: "flex",
                justifyContent: first ? "flex-start" : last ? "flex-end" : "center",
                fontSize: tick,
                fontWeight: 500,
                color: C.muted,
              }}
            >
              {l.label}
            </div>
          );
        })}

        {geometry.paths.map((p) => (
          <div
            key={`l${p.id}`}
            style={{
              position: "absolute",
              left: geometry.plot.right + 14,
              top: geometry.labelY[p.id] - endLabel * 0.62,
              height: endLabel * 1.24,
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: endLabel,
              lineHeight: 1.2,
            }}
          >
            <div
              style={{
                display: "flex",
                width: endLabel * 0.62,
                height: endLabel * 0.62,
                borderRadius: 999,
                // Satori throws on an `undefined` style value, so both branches
                // set a border rather than one leaving it unset.
                backgroundColor: p.dashed ? "transparent" : p.colorHex,
                border: `2px solid ${p.colorHex}`,
              }}
            />
            <div style={{ display: "flex", fontWeight: 800, color: C.text }}>{p.label}</div>
            <div style={{ display: "flex", fontWeight: 500, color: C.muted }}>{String(p.total)}</div>
          </div>
        ))}
      </div>
    </CardFrame>
  );
}

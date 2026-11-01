import type { RaceSession, ShareFormat } from "@/lib/share";
import { podiumOrder, type ResultKind, type ResultRow } from "@/lib/share-results";
import { fitFontSize } from "@/lib/share-text";
import { C, CardFrame, Clip, HEAD, Portrait, TeamBar } from "../_lib/frame";

export interface RaceCardProps {
  format: ShareFormat;
  season: number;
  round: number;
  session: RaceSession;
  raceName: string;
  circuitName: string | null;
  /** Top ten, classified order. */
  rows: ResultRow[];
  /** Portrait data URIs keyed by finishing position, for the podium. */
  portraits: Record<number, string | null>;
  host: string;
}

/** A legend entry for every non-finishing code the card actually prints. */
const KIND_LEGEND: Partial<Record<ResultKind, string>> = {
  dnf: "DNF did not finish",
  dsq: "DSQ disqualified",
  dns: "DNS did not start",
  nc: "NC not classified",
  excluded: "EXCL excluded",
};

const isOut = (kind: ResultKind) => kind !== "finished" && kind !== "lapped";

export function RaceCard(props: RaceCardProps) {
  const { format, season, round, session, raceName, circuitName, rows, portraits, host } = props;
  const landscape = format === "landscape";
  const gp = /\s*Grand Prix$/i.test(raceName);
  const title = gp ? raceName.replace(/\s*Grand Prix$/i, "") : raceName;
  const sessionLabel = session === "sprint" ? "Sprint" : "Race";

  const legend = Array.from(new Set(rows.map((r) => r.kind)))
    .map((kind) => KIND_LEGEND[kind])
    .filter(Boolean);
  const footnote = legend.length ? legend.join(" · ") : `${sessionLabel} classification · top ${rows.length}`;

  const podium = podiumOrder(rows.slice(0, 3));
  const rest = rows.slice(3);

  return (
    <CardFrame
      format={format}
      eyebrow={`${season} · Round ${round}${session === "sprint" ? " · Sprint" : ""}`}
      title={title}
      accent={gp ? "GP" : undefined}
      subtitle={`${sessionLabel} result${circuitName ? ` · ${circuitName}` : ""}`}
      footnote={footnote}
      host={host}
    >
      <div style={{ display: "flex", flexDirection: landscape ? "row" : "column", flex: 1, gap: landscape ? 24 : 28 }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: landscape ? 12 : 16,
            width: landscape ? 548 : 952,
            // Spread, not `height: undefined` — Satori throws on undefined values.
            ...(landscape ? {} : { height: 520 }),
            flexShrink: 0,
          }}
        >
          {podium.map(({ row, place }) => (
            <PodiumStep key={place} format={format} row={row} place={place} portrait={portraits[row.position] ?? null} />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: landscape ? 6 : 9 }}>
          {rest.map((row) => (
            <ResultLine key={row.position} format={format} row={row} />
          ))}
        </div>
      </div>
    </CardFrame>
  );
}

function PodiumStep({
  format,
  row,
  place,
  portrait,
}: {
  format: ShareFormat;
  row: ResultRow;
  place: 1 | 2 | 3;
  portrait: string | null;
}) {
  const landscape = format === "landscape";
  const width = landscape ? 174 : 306;
  const portraitH = landscape ? (place === 1 ? 196 : 158) : place === 1 ? 300 : 248;
  const nameSize = fitFontSize(row.familyName || row.fullName, {
    maxWidth: width - 28,
    maxSize: landscape ? 26 : 38,
    minSize: landscape ? 16 : 24,
  });
  const winner = place === 1;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width,
        borderRadius: 20,
        overflow: "hidden",
        border: `1px solid ${winner ? C.borderFlame : C.border}`,
        backgroundColor: winner ? C.panelStrong : C.panel,
      }}
    >
      <Portrait
        src={portrait}
        name={row.fullName}
        teamHex={row.teamHex}
        width={width}
        height={portraitH}
        frame="figure"
        radius={0}
      />
      <div style={{ display: "flex", height: 5, backgroundColor: row.teamHex }} />
      <div style={{ display: "flex", flexDirection: "column", padding: landscape ? "10px 14px 12px" : "16px 18px 18px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div
            style={{
              display: "flex",
              fontFamily: HEAD,
              fontWeight: 800,
              fontSize: landscape ? 30 : 46,
              color: winner ? C.flameLight : C.sub,
              lineHeight: 1,
            }}
          >
            {`P${place}`}
          </div>
          <div style={{ display: "flex", fontWeight: 700, fontSize: landscape ? 14 : 21, color: gapColor(row.kind, C.muted) }}>
            {row.gap}
          </div>
        </div>
        <Clip
          style={{
            marginTop: landscape ? 6 : 10,
            fontFamily: HEAD,
            fontWeight: 800,
            fontSize: nameSize,
            letterSpacing: -nameSize * 0.02,
            maxWidth: width - 28,
          }}
        >
          {row.familyName || row.fullName}
        </Clip>
        <Clip style={{ marginTop: 2, fontWeight: 700, fontSize: landscape ? 13 : 19, color: C.muted, maxWidth: width - 28 }}>
          {row.team}
        </Clip>
      </div>
    </div>
  );
}

function ResultLine({ format, row }: { format: ShareFormat; row: ResultRow }) {
  const landscape = format === "landscape";
  const size = landscape ? 19 : 28;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flex: 1,
        gap: landscape ? 14 : 20,
        padding: landscape ? "0 18px" : "0 24px",
        borderRadius: 14,
        border: `1px solid ${C.border}`,
        backgroundColor: C.panel,
      }}
    >
      <div style={{ display: "flex", width: landscape ? 30 : 46, fontWeight: 800, fontSize: size, color: C.dim }}>
        {String(row.position).padStart(2, "0")}
      </div>
      <TeamBar hex={row.teamHex} height={landscape ? 22 : 34} />
      <div style={{ display: "flex", alignItems: "baseline", flex: 1, minWidth: 0, gap: 10 }}>
        <Clip style={{ fontWeight: 700, fontSize: size, flexShrink: 0, maxWidth: landscape ? 260 : 420 }}>{row.fullName}</Clip>
        <Clip style={{ fontWeight: 500, fontSize: size * 0.72, color: C.muted, flex: 1, minWidth: 0 }}>{row.team}</Clip>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          fontWeight: 800,
          fontSize: size * 0.86,
          color: gapColor(row.kind, C.sub),
          flexShrink: 0,
        }}
      >
        {row.gap}
      </div>
    </div>
  );
}

function gapColor(kind: ResultKind, fallback: string): string {
  if (isOut(kind)) return C.error;
  if (kind === "lapped") return C.dim;
  return fallback;
}

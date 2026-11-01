import type { ShareFormat, StandingsKind } from "@/lib/share";
import { isTiedOnPoints, shortRaceName, type StandingRow } from "@/lib/share-results";
import { fitFontSize } from "@/lib/share-text";
import { C, CardFrame, Clip, EmptyBody, HEAD, Portrait, TeamBar } from "../_lib/frame";

export interface StandingsCardProps {
  format: ShareFormat;
  kind: StandingsKind;
  season: number;
  /** Leader first, already capped to what the card shows. */
  rows: StandingRow[];
  /** How many entries the full table has, so a capped card can say "of 23". */
  totalEntries: number;
  leaderPortrait: string | null;
  afterRound: { round: number; raceName: string } | null;
  /** A past season: these are the final standings, not a snapshot. */
  isFinal: boolean;
  host: string;
}

/**
 * How many rows a standings card shows.
 *
 * The top ten drivers — the points-paying positions, which is what a
 * shared championship table is about — and the whole constructors' field,
 * which is never more than eleven. Both formats show the same rows; portrait
 * gets bigger type, not a longer list, so the two images say the same thing.
 */
export function standingsRowLimit(kind: StandingsKind): number {
  return kind === "drivers" ? 10 : 11;
}

export function StandingsCard(props: StandingsCardProps) {
  const { format, kind, season, rows, totalEntries, leaderPortrait, afterRound, isFinal, host } = props;
  const label = kind === "drivers" ? "Drivers'" : "Constructors'";
  const subtitle = afterRound
    ? `${isFinal ? "Final standings" : "Standings"} after Round ${afterRound.round} · ${shortRaceName(afterRound.raceName)}`
    : `${season} season`;
  const anyTie = rows.some((_, i) => isTiedOnPoints(rows, i));
  const capped = totalEntries > rows.length;
  const footnote = [
    capped ? `Top ${rows.length} of ${totalEntries}` : null,
    anyTie ? "Level on points: order is by countback" : null,
    !isFinal && !anyTie ? "Can lag official timing by up to an hour" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (rows.length === 0) {
    return (
      <CardFrame
        format={format}
        eyebrow={`${season} · Championship`}
        title={`${season} ${label}`}
        accent="standings"
        subtitle={subtitle}
        footnote="No results on record yet"
        host={host}
      >
        <EmptyBody
          format={format}
          title="No races completed yet"
          detail={`The ${season} ${label.toLowerCase()} championship has no points on the board. Standings appear here after the first race.`}
        />
      </CardFrame>
    );
  }

  const [leader, ...rest] = rows;
  const landscape = format === "landscape";

  return (
    <CardFrame
      format={format}
      eyebrow={afterRound ? `${season} · Round ${afterRound.round}` : `${season}`}
      title={`${season} ${label}`}
      accent="standings"
      subtitle={subtitle}
      footnote={footnote || `${season} Formula 1 World Championship`}
      host={host}
    >
      <div style={{ display: "flex", flexDirection: landscape ? "row" : "column", flex: 1, gap: landscape ? 22 : 26 }}>
        <LeaderPanel format={format} kind={kind} row={leader} portrait={leaderPortrait} />
        <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: landscape ? 5 : 8 }}>
          {rest.map((row, i) => (
            <StandingLine key={`${row.position}-${row.name}`} format={format} row={row} tied={isTiedOnPoints(rows, i + 1)} />
          ))}
        </div>
      </div>
    </CardFrame>
  );
}

function LeaderPanel({
  format,
  kind,
  row,
  portrait,
}: {
  format: ShareFormat;
  kind: StandingsKind;
  row: StandingRow;
  portrait: string | null;
}) {
  const landscape = format === "landscape";
  const width = landscape ? 420 : 952;
  // Spread into the style below rather than set to `undefined`: Satori throws
  // on an undefined style value instead of ignoring it.
  const heightStyle = landscape ? {} : { height: 330 };
  const driver = kind === "drivers";
  // Taller than the panel on purpose: the `figure` frame is meant to be cut
  // off by the panel's bottom edge, so the driver stands in the card.
  const portraitW = landscape ? 158 : 250;
  const portraitH = landscape ? 400 : 360;
  const textWidth = width - (driver ? portraitW + 54 : 60);
  // Drivers: given name small above a big family name. "Andrea Kimi
  // Antonelli" on one line either shrinks to nothing or ellipsises the very
  // word that identifies him; split, the surname gets the whole width.
  const big = driver ? row.familyName || row.name : row.name;
  const nameSize = fitFontSize(big, {
    maxWidth: textWidth,
    maxSize: landscape ? 46 : 64,
    minSize: landscape ? 26 : 38,
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "flex-start",
        width,
        ...heightStyle,
        flexShrink: 0,
        borderRadius: 22,
        border: `1px solid ${C.borderFlame}`,
        backgroundColor: C.panelStrong,
        // The leader's team colour, glowing up from the bottom corner — the
        // one place on the card where the colour gets more than a hairline.
        backgroundImage: `radial-gradient(circle at 12% 110%, ${row.teamHex}40 0%, ${row.teamHex}00 60%)`,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 7,
          backgroundColor: row.teamHex,
        }}
      />
      {driver && (
        <Portrait
          src={portrait}
          name={row.name}
          teamHex={row.teamHex}
          width={portraitW}
          height={portraitH}
          frame="figure"
          radius={0}
        />
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignSelf: "stretch",
          flex: 1,
          minWidth: 0,
          padding: landscape ? "22px 24px 22px 26px" : "28px 34px",
        }}
      >
        <div
          style={{
            display: "flex",
            fontWeight: 800,
            fontSize: landscape ? 14 : 19,
            letterSpacing: 2.4,
            textTransform: "uppercase",
            color: C.flameMid,
          }}
        >
          P1 · Leader
        </div>
        {driver && row.givenName && (
          <Clip style={{ marginTop: 10, fontSize: landscape ? 21 : 30, fontWeight: 700, color: C.sub, maxWidth: textWidth }}>
            {row.givenName}
          </Clip>
        )}
        <div
          style={{
            display: "block",
            marginTop: driver ? 0 : 8,
            fontFamily: HEAD,
            fontWeight: 800,
            fontSize: nameSize,
            letterSpacing: -nameSize * 0.03,
            lineHeight: 1.06,
            maxWidth: textWidth,
            overflow: "hidden",
            textOverflow: "ellipsis",
            lineClamp: 2,
          }}
        >
          {big}
        </div>
        {row.team && (
          <Clip style={{ marginTop: 4, fontSize: landscape ? 17 : 24, fontWeight: 700, color: C.sub, maxWidth: textWidth }}>
            {row.team}
          </Clip>
        )}
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: landscape ? 12 : 20 }}>
          <div
            style={{
              display: "flex",
              fontFamily: HEAD,
              fontWeight: 800,
              fontSize: landscape ? 54 : 84,
              letterSpacing: -2,
              color: C.flameLight,
              lineHeight: 1,
            }}
          >
            {row.points}
          </div>
          <div style={{ display: "flex", fontSize: landscape ? 16 : 22, fontWeight: 700, color: C.muted }}>PTS</div>
          <div style={{ display: "flex", marginLeft: 14, fontSize: landscape ? 16 : 22, fontWeight: 700, color: C.muted }}>
            {`${row.wins} win${row.wins === 1 ? "" : "s"}`}
          </div>
        </div>
      </div>
    </div>
  );
}

function StandingLine({ format, row, tied }: { format: ShareFormat; row: StandingRow; tied: boolean }) {
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
      <div
        style={{
          display: "flex",
          width: landscape ? 30 : 46,
          fontWeight: 800,
          fontSize: size,
          color: C.dim,
        }}
      >
        {String(row.position).padStart(2, "0")}
      </div>
      <TeamBar hex={row.teamHex} height={landscape ? 22 : 34} />
      <div style={{ display: "flex", alignItems: "baseline", flex: 1, minWidth: 0, gap: 10 }}>
        <Clip style={{ fontWeight: 700, fontSize: size, flexShrink: 0, maxWidth: landscape ? 330 : 520 }}>{row.name}</Clip>
        {row.team && (
          <Clip style={{ fontWeight: 500, fontSize: size * 0.72, color: C.muted, flex: 1, minWidth: 0 }}>{row.team}</Clip>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <div style={{ display: "flex", fontWeight: 800, fontSize: size * 1.05 }}>{row.points}</div>
        <div style={{ display: "flex", fontWeight: 700, fontSize: size * 0.58, color: C.dim }}>PTS</div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          width: landscape ? 64 : 96,
          fontWeight: 700,
          fontSize: size * 0.74,
          color: tied ? C.flameLight : C.dim,
        }}
      >
        {tied ? "level" : row.behind > 0 ? `−${row.behind}` : "—"}
      </div>
    </div>
  );
}

"use client";

import { AnimatedNumber } from "@/components/animated-number";
import LocalDateTime from "@/components/local-datetime";
import TiltCard from "@/components/tilt-card";
import TrackMap from "@/components/track-map";
import { getTeamColor } from "@/lib/team-colors";
import { BentoDriverArt, Kicker, raceStartMs, type WidgetProps } from "../widget-kit";

/* The three cards that were the old home page's "bento" row. Each `m` (leader)
   and `s` (last race, next circuit) design is the old card as it was; the other
   sizes are new. Class strings are kept identical to the old page where a size
   reproduces an old card, so the default layout is the old page pixel for
   pixel inside each card. */

/* No `display` here: TiltCard renders a Link (inline by default), so each card
   adds `block` or `flex` itself — never both, since which one wins would then
   depend on Tailwind's output order rather than on the class string. */
const CARD = "apex-glass apex-sheen rounded-panel overflow-hidden h-full";

/* --------------------------- championship leader --------------------------- */

export function LeaderWidget({ data, size }: WidgetProps) {
  const leader = data.drivers[0];
  const second = data.drivers[1];
  const points = leader?.points ?? 0;

  if (size === "s") {
    return (
      <TiltCard className={`${CARD} block p-5 lg:p-[26px]`}>
        <BentoDriverArt given={leader?.givenName} family={leader?.familyName} accent compact />
        <div className="relative flex flex-col h-full">
          <Kicker>Leader</Kicker>
          <div className="font-[family-name:var(--font-headline)] font-bold text-[20px] leading-[1.05] mt-3 truncate">
            {leader?.familyName || "TBC"}
          </div>
          <div className="font-semibold text-xs text-warm-400 truncate">{leader?.team || "—"}</div>
          <div className="mt-auto flex items-baseline gap-1.5">
            <span className="font-extrabold text-[36px] leading-none tabular-nums">{points || "—"}</span>
            <span className="font-semibold text-[11px] tracking-[0.08em] uppercase text-warm-500">Pts</span>
          </div>
          {second && (
            <div className="mt-1 font-semibold text-[11px] text-warm-500 tabular-nums truncate">
              +{Math.max(points - second.points, 0)} on {second.familyName}
            </div>
          )}
        </div>
      </TiltCard>
    );
  }

  return (
    <TiltCard className={`${CARD} block p-[26px] min-h-[224px]`}>
      <BentoDriverArt given={leader?.givenName} family={leader?.familyName} accent />
      <div className="relative max-w-[62%]">
        <span className="font-bold text-[11px] tracking-[0.14em] uppercase text-flame">Championship leader</span>
        <div className="font-[family-name:var(--font-headline)] font-bold text-[22px] leading-[1.05] my-[14px] mb-[3px]">
          {leader?.name || "TBC"}
        </div>
        <div className="font-semibold text-xs text-warm-400">{leader?.team || "—"}</div>
        <div className="mt-5 flex items-baseline gap-2">
          {points ? (
            <AnimatedNumber value={points} className="font-extrabold text-[44px] leading-none tabular-nums" />
          ) : (
            <span className="font-extrabold text-[44px] leading-none tabular-nums">—</span>
          )}
          <span className="font-semibold text-[11px] tracking-[0.08em] uppercase text-warm-500">Pts</span>
        </div>
      </div>
    </TiltCard>
  );
}

/* ------------------------------ last time out ------------------------------ */

export function LastRaceWidget({ data, size }: WidgetProps) {
  const race = data.lastRace;
  const winner = race?.podium[0];
  const winnerColor = getTeamColor(winner?.team);
  const gp = race ? race.raceName.replace(" Grand Prix", " GP") : null;

  if (size === "l" && race) {
    return <LastRacePodium data={data} />;
  }

  const compact = size === "s";
  return (
    <TiltCard className={`${CARD} block ${compact ? "p-5 lg:p-[26px]" : "p-[26px] min-h-[224px]"}`}>
      <BentoDriverArt given={winner?.givenName} family={winner?.familyName} compact={compact} />
      <div className={compact ? "relative flex flex-col h-full" : "relative max-w-[62%]"}>
        <span className="font-bold text-[11px] tracking-[0.14em] uppercase text-warm-300 truncate">
          Last time out
        </span>
        <div
          className={`font-[family-name:var(--font-headline)] font-bold leading-[1.05] ${
            compact ? "text-[20px] mt-3 line-clamp-2" : "text-[22px] my-[14px] mb-[3px]"
          }`}
        >
          {winner?.name || "TBC"}
        </div>
        <div className="font-semibold text-xs text-warm-400 truncate">{gp ? `${gp} · Win` : "—"}</div>
        {winner?.time && (
          <div
            className={`inline-flex items-center gap-2 bg-primary-container/12 rounded-control self-start ${
              compact ? "mt-auto px-[11px] py-[7px]" : "mt-[22px] px-[13px] py-[9px]"
            }`}
          >
            <span className="w-[6px] h-[6px] rounded-full" style={{ background: winnerColor.hex }} />
            <span className="font-bold text-sm text-primary tabular-nums">{winner.time}</span>
          </div>
        )}
      </div>
    </TiltCard>
  );
}

/** The large size: the whole podium, not just the winner. Costs no request —
 * the page already fetched this race's results to name the winner. */
function LastRacePodium({ data }: { data: WidgetProps["data"] }) {
  const race = data.lastRace!;
  const [winner, ...rest] = race.podium;
  const color = getTeamColor(winner.team);
  return (
    <TiltCard href={race.href} ariaLabel={`${race.raceName} results`} className={`${CARD} block p-[26px]`}>
      <div className="relative flex flex-col h-full">
        <div className="flex items-baseline justify-between gap-3">
          <Kicker tone="muted">Last time out</Kicker>
          <span className="font-semibold text-[10px] tracking-[0.06em] uppercase text-warm-500 whitespace-nowrap">
            Round {race.round}
          </span>
        </div>
        <div className="font-[family-name:var(--font-headline)] font-bold text-[22px] leading-[1.05] mt-2">
          {race.raceName}
        </div>

        <div className="relative flex-1 min-h-0 mt-4 rounded-tile bg-veil/4 overflow-hidden">
          <BentoDriverArt given={winner.givenName} family={winner.familyName} />
          <div className="relative p-4 max-w-[60%]">
            <span className="font-[family-name:var(--font-headline)] font-extrabold text-[15px] text-primary">P1</span>
            <div className="font-[family-name:var(--font-headline)] font-bold text-[22px] leading-[1.05] mt-1">
              {winner.name}
            </div>
            <div className="font-semibold text-xs text-warm-400 mt-0.5">{winner.team}</div>
            {winner.time && (
              <div className="mt-4 inline-flex items-center gap-2 bg-primary-container/12 rounded-control px-[13px] py-[9px]">
                <span className="w-[6px] h-[6px] rounded-full" style={{ background: color.hex }} />
                <span className="font-bold text-sm text-primary tabular-nums">{winner.time}</span>
              </div>
            )}
          </div>
        </div>

        <ol className="mt-3 grid gap-2">
          {rest.map((row) => (
            <li key={row.position} className="flex items-center gap-2.5 rounded-control bg-veil/4 px-3 py-2.5 min-w-0">
              <span
                aria-hidden
                className="w-[3px] self-stretch rounded-full flex-none"
                style={{ background: getTeamColor(row.team).hex }}
              />
              <span className="font-[family-name:var(--font-headline)] font-extrabold text-[15px] tabular-nums text-warm-500 w-4">
                {row.position}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-[13px] truncate">{row.name}</span>
                <span className="block font-medium text-[10px] text-warm-500 truncate">{row.team || "—"}</span>
              </span>
              <span className="font-semibold text-[11px] tabular-nums text-warm-300 whitespace-nowrap">{row.time}</span>
            </li>
          ))}
        </ol>
      </div>
    </TiltCard>
  );
}

/* ------------------------------- next circuit ------------------------------- */

export function NextCircuitWidget({ data, size }: WidgetProps) {
  const c = data.nextCircuit;
  const shortCircuit = c.circuitName?.split(" ").slice(0, 2).join(" ") ?? "TBC";

  if (size === "s") {
    // The old card. Its map was a fixed 100px; here it takes whatever height
    // the cell leaves, so the same design fits a 212px phone cell and a 252px
    // desktop one without clipping the labels underneath.
    return (
      <TiltCard href={c.href} className={`${CARD} p-[26px] min-h-[224px] flex flex-col`} ariaLabel="Next circuit">
        <span className="relative font-bold text-[11px] tracking-[0.14em] uppercase text-flame">Next circuit</span>
        <TrackMap
          src={c.image}
          alt={c.circuitName ?? "Circuit"}
          containerClassName="relative my-4 flex-1 min-h-[64px] max-h-[100px] rounded-tile"
          imgClassName="object-contain p-3 opacity-80"
        />
        <div className="relative flex justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500">Circuit</div>
            <div className="font-[family-name:var(--font-headline)] font-bold text-base mt-1 truncate">{shortCircuit}</div>
          </div>
          <div className="text-right min-w-0">
            <div className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500">Country</div>
            <div className="font-[family-name:var(--font-headline)] font-bold text-base mt-1 truncate">
              {c.country || "TBC"}
            </div>
          </div>
        </div>
      </TiltCard>
    );
  }

  const raceMs = raceStartMs(data.nextRace?.date, data.nextRace?.time);
  const facts = [
    { k: "Round", v: c.round ?? "—" },
    { k: "Where", v: [c.locality, c.country].filter(Boolean).join(", ") || "TBC" },
    {
      k: "Race",
      v:
        raceMs !== null ? (
          <LocalDateTime
            timestampMs={raceMs}
            options={{ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }}
          />
        ) : (
          "TBC"
        ),
    },
    { k: "Format", v: c.isSprint ? "Sprint weekend" : "Standard weekend" },
  ];

  if (size === "m") {
    return (
      <TiltCard href={c.href} className={`${CARD} block p-[26px]`} ariaLabel={`Next circuit: ${c.circuitName ?? "TBC"}`}>
        <div className="relative grid grid-cols-[1fr_1.1fr] gap-5 h-full">
          <div className="flex flex-col min-w-0">
            <Kicker>Next circuit</Kicker>
            <div className="font-[family-name:var(--font-headline)] font-bold text-lg leading-tight mt-2 line-clamp-2">
              {c.circuitName ?? "TBC"}
            </div>
            <dl className="mt-auto grid gap-1.5">
              {facts.slice(0, 3).map((f) => (
                <div key={f.k} className="flex justify-between gap-2 text-[12px] font-semibold">
                  <dt className="text-warm-500">{f.k}</dt>
                  <dd className="truncate text-right">{f.v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <TrackMap
            src={c.image}
            alt=""
            containerClassName="relative h-full rounded-tile"
            imgClassName="object-contain p-3 opacity-85"
          />
        </div>
      </TiltCard>
    );
  }

  // `l`: the map gets the room it never had, with the weekend underneath.
  return (
    <TiltCard href={c.href} className={`${CARD} p-[26px] flex flex-col`} ariaLabel={`Next circuit: ${c.circuitName ?? "TBC"}`}>
      <div className="relative flex items-baseline justify-between gap-3">
        <Kicker>Next circuit</Kicker>
        <span className="font-semibold text-[10px] tracking-[0.06em] uppercase text-warm-500 whitespace-nowrap">
          {c.raceName.replace(" Grand Prix", " GP")}
        </span>
      </div>
      <div className="relative font-[family-name:var(--font-headline)] font-bold text-[22px] leading-tight mt-2 truncate">
        {c.circuitName ?? "TBC"}
      </div>
      <TrackMap
        src={c.image}
        alt={c.circuitName ?? "Circuit"}
        containerClassName="relative my-4 flex-1 min-h-0 rounded-tile"
        imgClassName="object-contain p-4 opacity-90"
      />
      <dl className="relative grid grid-cols-2 gap-x-5 gap-y-3">
        {facts.map((f) => (
          <div key={f.k} className="min-w-0">
            <dt className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500">{f.k}</dt>
            <dd className="font-[family-name:var(--font-headline)] font-bold text-[15px] mt-0.5 truncate">{f.v}</dd>
          </div>
        ))}
      </dl>
      {data.upcomingSessions.length > 0 && (
        <p className="relative mt-3 text-[11px] font-medium text-warm-500">
          Next up: {data.upcomingSessions[0].sessionLabel} ·{" "}
          <LocalDateTime
            timestampMs={data.upcomingSessions[0].startTimeMs}
            options={{ weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }}
          />{" "}
          your time
        </p>
      )}
    </TiltCard>
  );
}

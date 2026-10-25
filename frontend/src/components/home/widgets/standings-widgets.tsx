"use client";

import Link from "next/link";
import type { ConstructorStanding } from "@/lib/api";
import { computeTitleDecider, type StandingEntry, type TitleDeciderResult } from "@/lib/championship-math";
import { getTeamColor } from "@/lib/team-colors";
import type { WidgetSize } from "@/lib/home-layout";
import { useConstructorStandings } from "../use-constructor-standings";
import { Kicker, SkeletonRows, type WidgetProps } from "../widget-kit";

/** How many rows each size shows. The brief: top 3 / 5 / 10. */
const ROWS: Record<WidgetSize, number> = { s: 3, m: 5, l: 10, full: 10 };

interface Row {
  key: string;
  position: string;
  label: string;
  sub?: string;
  team: string;
  points: number;
}

/**
 * A standings table at three lengths. Rows share the card's height
 * (`flex-1`) rather than having a fixed height each, so the same component
 * fills a 212px phone cell and a 252px desktop one without a gap at the
 * bottom or a clipped last row.
 */
function StandingsCard({
  title,
  size,
  rows,
  loading,
  failed,
  href,
}: {
  title: string;
  size: WidgetSize;
  rows: Row[];
  loading?: boolean;
  failed?: boolean;
  href: string;
}) {
  const count = ROWS[size];
  const compact = size === "s";
  return (
    <div className="apex-glass apex-sheen rounded-panel overflow-hidden h-full p-5 flex flex-col">
      <div className="relative flex items-baseline justify-between gap-3 mb-3">
        <Kicker>{title}</Kicker>
        <Link
          href={href}
          className="relative font-semibold text-[10px] tracking-[0.06em] uppercase text-warm-500 hover:text-warm-200 whitespace-nowrap transition-colors before:absolute before:-inset-3 before:content-['']"
        >
          {compact ? "All →" : "Full table →"}
        </Link>
      </div>
      {loading ? (
        <SkeletonRows count={count} />
      ) : failed || rows.length === 0 ? (
        <p className="relative text-xs font-medium text-warm-400">Standings unavailable right now.</p>
      ) : (
        <ol className="relative flex-1 min-h-0 flex flex-col justify-between gap-1">
          {rows.slice(0, count).map((row, i) => (
            <li
              key={row.key}
              className={`flex-1 max-h-10 min-h-0 flex items-center gap-2.5 rounded-control px-2.5 ${
                i === 0 ? "bg-primary-container/10" : "bg-veil/4"
              }`}
            >
              <span
                aria-hidden
                className="w-[3px] h-[60%] rounded-full flex-none"
                style={{ background: getTeamColor(row.team).hex }}
              />
              <span
                className={`w-5 font-[family-name:var(--font-headline)] font-extrabold text-[13px] tabular-nums flex-none ${
                  i === 0 ? "text-primary" : "text-warm-500"
                }`}
              >
                {row.position}
              </span>
              <span className="min-w-0 flex-1 font-bold text-[13px] truncate">
                {row.label}
                {row.sub && !compact && (
                  <span className="ml-2 font-medium text-[11px] text-warm-500">{row.sub}</span>
                )}
              </span>
              <span className="font-semibold text-[12px] tabular-nums text-warm-200 whitespace-nowrap">
                {row.points}
                <span className="ml-0.5 text-[10px] text-warm-500">{compact ? "" : " pts"}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** From server data the page already fetched — no request of its own. */
export function DriverStandingsWidget({ data, size }: WidgetProps) {
  const rows: Row[] = data.drivers.map((d) => ({
    key: d.code || d.name,
    position: d.position,
    // A surname is what fits a 1×1 tile on a phone; the larger sizes have
    // room for the full name and the team beside it.
    label: size === "s" ? d.familyName || d.name : d.name,
    sub: d.team,
    team: d.team,
    points: d.points,
  }));
  return <StandingsCard title="Drivers" size={size} rows={rows} href="/standings" />;
}

function constructorRows(list: ConstructorStanding[]): Row[] {
  return list.map((c, i) => ({
    key: c.Constructor.constructorId || c.Constructor.name || String(i),
    position: c.position || String(i + 1),
    label: c.Constructor.name || "—",
    team: c.Constructor.name || "",
    points: Number(c.points) || 0,
  }));
}

/**
 * The only standings the default page never fetched, so this widget fetches
 * the table itself — client-side, on mount, and only because it is on the
 * layout. The skeleton has the rows' final geometry, so nothing moves when
 * the data lands.
 */
export function ConstructorStandingsWidget({ data, size }: WidgetProps) {
  const res = useConstructorStandings(data.seasonYear);
  return (
    <StandingsCard
      title="Constructors"
      size={size}
      rows={res.status === "ready" ? constructorRows(res.data) : []}
      loading={res.status === "loading"}
      failed={res.status === "error"}
      href="/standings"
    />
  );
}

/* -------------------------------- title fight -------------------------------- */

function roundsLabel(result: TitleDeciderResult): string {
  const { remainingRaces, remainingSprints } = result;
  return [
    remainingRaces > 0 ? `${remainingRaces} race${remainingRaces === 1 ? "" : "s"}` : null,
    remainingSprints > 0 ? `${remainingSprints} sprint${remainingSprints === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" + ");
}

/**
 * "Who can still win it, and what do they need?" — the title decider from
 * `/standings`, reduced to a card.
 *
 * The maths is `computeTitleDecider` unchanged, run once per contender as a
 * leader-versus-contender pair: that function deliberately models P1 vs P2
 * only, and asking it the same question about P3 is exactly that question
 * with a different runner-up. What it *cannot* say is how a points tie would
 * break (wins countback), so a contender is never told they "need N to win"
 * — only how many points they must make up and how many are left, which is
 * true whatever the countback does.
 */
function contenderLines(entries: StandingEntry[], races: WidgetProps["data"]["titleRaces"], scope: "driver" | "constructor", nowMs: number, max: number) {
  const leader = entries[0];
  if (!leader) return null;
  const now = new Date(nowMs);
  const head = computeTitleDecider(entries, races, scope, now);
  if (!head) return null;
  const contenders = entries.slice(1, 1 + max).map((entry) => {
    const pair = computeTitleDecider([leader, entry], races, scope, now)!;
    return { name: entry.name, gap: pair.gap, out: pair.clinched, max: pair.maxRemainingPoints };
  });
  return { head, contenders };
}

function TitleBlock({
  label,
  lines,
}: {
  label: string;
  lines: NonNullable<ReturnType<typeof contenderLines>>;
}) {
  const { head, contenders } = lines;
  const rounds = roundsLabel(head);
  const seasonOver = head.remainingRaces === 0 && head.remainingSprints === 0;
  return (
    <div className="min-w-0">
      <div className="flex justify-between gap-3 mb-1">
        <span className="font-semibold text-[11px] tracking-[0.04em] uppercase text-warm-400 truncate">{label}</span>
        <span className="font-bold text-[11px] tabular-nums text-warm-300 whitespace-nowrap">
          {head.gap} pt{head.gap === 1 ? "" : "s"} clear
        </span>
      </div>
      <div className="text-[15px] font-bold text-warm-100 truncate">{head.leader.name}</div>
      <p className={`mt-0.5 text-xs font-medium ${head.clinched ? "text-primary" : "text-warm-400"}`}>
        {seasonOver
          ? "Season complete."
          : head.clinched
            ? `Champion — no one can close the gap over the ${head.maxRemainingPoints} points left.`
            : `${head.maxRemainingPoints} pts left${rounds ? ` across ${rounds}` : ""}; clinches by stretching the lead ${head.pointsToClinch} more.`}
      </p>
      {!seasonOver && !head.clinched && (
        <ul className="mt-2.5 grid gap-1.5">
          {contenders.map((c) => (
            <li key={c.name} className="flex items-baseline justify-between gap-3 text-[12px] font-semibold">
              <span className={`truncate ${c.out ? "text-warm-500 line-through decoration-warm-600" : "text-warm-200"}`}>
                {c.name}
              </span>
              <span className={`whitespace-nowrap tabular-nums ${c.out ? "text-warm-500" : "text-warm-300"}`}>
                {c.out ? "out of contention" : `−${c.gap} to make up`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const toEntries = (rows: { name: string; points: number }[]): StandingEntry[] =>
  rows.map((r) => ({ name: r.name, points: r.points }));

export function TitleFightWidget({ data, size }: WidgetProps) {
  const drivers = contenderLines(toEntries(data.drivers), data.titleRaces, "driver", data.nowMs, size === "l" ? 3 : 2);
  // Constructors only at `l`: it is the one part of this widget that costs a
  // request, so the medium size — which has no room for it — never asks.
  const constructors = useConstructorStandings(data.seasonYear, size === "l");

  return (
    <div className="apex-glass apex-sheen rounded-panel overflow-hidden h-full p-5 lg:p-[22px] flex flex-col">
      <div className="relative flex items-baseline justify-between gap-3 mb-3">
        <Kicker>Title fight</Kicker>
        <Link
          href="/standings"
          className="relative font-semibold text-[10px] tracking-[0.06em] uppercase text-warm-500 hover:text-warm-200 whitespace-nowrap transition-colors before:absolute before:-inset-3 before:content-['']"
        >
          Standings →
        </Link>
      </div>
      {!drivers ? (
        <p className="relative text-xs font-medium text-warm-400">Title maths unavailable right now.</p>
      ) : (
        <div className={`relative flex-1 min-h-0 ${size === "l" ? "flex flex-col gap-5" : ""}`}>
          <TitleBlock label="Drivers" lines={drivers} />
          {size === "l" && (
            <div className="border-t border-veil/7 pt-4">
              {constructors.status === "loading" ? (
                <div className="animate-pulse grid gap-2" aria-hidden="true">
                  <div className="h-3 w-24 rounded bg-veil/6" />
                  <div className="h-4 w-40 rounded bg-veil/6" />
                  <div className="h-8 rounded bg-veil/5" />
                </div>
              ) : constructors.status === "error" ? (
                <p className="text-xs font-medium text-warm-400">Constructors&apos; table unavailable right now.</p>
              ) : (
                (() => {
                  const lines = contenderLines(
                    constructorRows(constructors.data).map((r) => ({ name: r.label, points: r.points })),
                    data.titleRaces,
                    "constructor",
                    data.nowMs,
                    2
                  );
                  return lines ? <TitleBlock label="Constructors" lines={lines} /> : null;
                })()
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

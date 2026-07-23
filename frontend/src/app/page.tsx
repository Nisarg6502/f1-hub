import Link from "next/link";
import Image from "next/image";
import {
  getActiveSeasonYear,
  getDriverStandings,
  getSeasonRaces,
  getRaceResults,
} from "@/lib/api";
import CountdownTimer from "@/components/countdown-timer";
import HeroFX from "@/components/hero-fx";
import TiltCard from "@/components/tilt-card";
import TrackMap from "@/components/track-map";
import LocalDateTime from "@/components/local-datetime";
import { AnimatedNumber } from "@/components/animated-number";
import { AnimatedRing } from "@/components/animated-ring";
import { Reveal, Stagger, StaggerItem } from "@/components/motion-primitives";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { getCircuitImagePath } from "@/lib/circuit-images";
import { getTeamColor } from "@/lib/team-colors";
import { buildRaceSessionTimeline, getUpcomingSessions } from "@/lib/sessions";

// Rendered per request: the "next race" and "latest winner" depend on the
// current time, so a prerender goes stale the moment a race is run.
export const dynamic = "force-dynamic";

function parseRaceMs(date?: string, time?: string): number | null {
  if (!date) return null;
  const baseTime = time ?? "12:00:00Z";
  const iso = baseTime.endsWith("Z") ? `${date}T${baseTime}` : `${date}T${baseTime}Z`;
  const ts = new Date(iso).getTime();
  return Number.isNaN(ts) ? null : ts;
}

export default async function Home() {
  const seasonYear = getActiveSeasonYear();
  const nowMs = Date.now();

  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"] = [];
  let driverStandings: Awaited<
    ReturnType<typeof getDriverStandings>
  >["driver_standings"] = [];

  try {
    const [racesRes, driverStandingsRes] = await Promise.all([
      getSeasonRaces(seasonYear),
      getDriverStandings(seasonYear),
    ]);
    races = racesRes.races ?? [];
    driverStandings = driverStandingsRes.driver_standings ?? [];
  } catch {
    // Backend offline — render with empty data
  }

  const withTs = races
    .map((race) => ({ race, ts: parseRaceMs(race.date, race.time) }))
    .filter((r): r is { race: (typeof races)[number]; ts: number } => r.ts !== null);

  const nextRace =
    withTs
      .filter((r) => r.ts > nowMs)
      .sort((a, b) => a.ts - b.ts)[0]?.race ??
    races.find((r) => r.date) ??
    races.at(-1);

  const completed = withTs
    .filter((r) => r.ts <= nowMs)
    .sort((a, b) => b.ts - a.ts);
  const latestCompletedRace = completed[0]?.race;

  let latestWinner: {
    name: string;
    team: string;
    raceName: string;
    time: string;
    givenName: string;
    familyName: string;
  } | null = null;
  if (latestCompletedRace) {
    try {
      const res = await getRaceResults(seasonYear, Number(latestCompletedRace.round));
      const winner = (res.results ?? [])[0];
      if (winner) {
        latestWinner = {
          name: `${winner.Driver?.givenName ?? ""} ${winner.Driver?.familyName ?? ""}`.trim(),
          team: winner.Constructor?.name ?? "",
          raceName: latestCompletedRace.raceName,
          time: winner.Time?.time ?? "",
          givenName: winner.Driver?.givenName ?? "",
          familyName: winner.Driver?.familyName ?? "",
        };
      }
    } catch {
      // no results yet
    }
  }

  const leader = driverStandings[0];
  const second = driverStandings[1];
  const leaderName = leader
    ? `${leader.Driver.givenName ?? ""} ${leader.Driver.familyName ?? ""}`.trim()
    : "";
  const leaderTeam = leader?.Constructors?.[0]?.name ?? "";
  const leaderPts = Number(leader?.points ?? 0);
  const secondPts = Number(second?.points ?? 0);
  const ptsGap = Math.max(leaderPts - secondPts, 0);
  const leaderWins = leader?.wins ?? "0";
  const leaderColor = getTeamColor(leaderTeam);

  const total = races.length;
  const done = completed.length;
  const roundsLeft = Math.max(total - done, 0);
  const elapsedPct = total ? done / total : 0;
  const gapPct = leaderPts > 0 ? Math.min(ptsGap / leaderPts, 1) : 0;

  // Countdown hero context
  const heroRaceName = nextRace?.raceName ?? "Next Grand Prix";
  const heroBase = heroRaceName.replace(" Grand Prix", "");
  const heroHasGP = heroBase !== heroRaceName;
  const heroLocality = nextRace?.Circuit?.Location?.locality;
  const heroCircuit = nextRace?.Circuit?.circuitName;
  const nextRaceCountry = nextRace?.Circuit?.Location?.country ?? "";

  const upcomingSessions = getUpcomingSessions(
    buildRaceSessionTimeline(nextRace),
    nowMs,
    4
  );

  const winnerColor = getTeamColor(latestWinner?.team);
  const circuitImg = getCircuitImagePath(
    nextRaceCountry,
    heroLocality,
    heroCircuit
  );

  const RING = 276; // 2πr for r=44

  return (
    <>
      {/* ===================== HERO ===================== */}
      <section className="relative overflow-hidden px-6 md:px-10 pt-12 pb-11 min-h-[520px]">
        <HeroFX />
        <div className="relative grid lg:grid-cols-[1.4fr_0.78fr] gap-10 lg:gap-[52px] items-center">
          {/* Left */}
          <div className="min-w-0">
            <div className="flex items-center gap-[13px] mb-6 anim-rise">
              <span className="font-bold text-xs tracking-[0.16em] uppercase text-[#FF7A3D]">
                {nextRace ? `Round ${nextRace.round}` : "Season 2026"}
              </span>
              {(heroLocality || heroCircuit) && (
                <>
                  <span className="w-[5px] h-[5px] rounded-full bg-warm-700" />
                  <span className="font-semibold text-xs tracking-[0.1em] uppercase text-warm-400">
                    {[heroLocality, heroCircuit].filter(Boolean).join(" · ")}
                  </span>
                </>
              )}
            </div>

            <div className="leading-[0.94] mb-3">
              <div className="font-[family-name:var(--font-headline)] font-bold text-5xl sm:text-6xl md:text-[80px] tracking-[-2px] anim-fade">
                {heroBase}
              </div>
              {heroHasGP && (
                <div
                  className="font-[family-name:var(--font-headline)] font-extrabold text-5xl sm:text-6xl md:text-[80px] tracking-[-2px] apex-flame-text anim-fade"
                  style={{ animationDelay: "0.12s" }}
                >
                  Grand Prix
                </div>
              )}
            </div>

            <div
              className="h-[2px] w-[130px] bg-[linear-gradient(90deg,#FF5A1F,transparent)] anim-line mb-8"
              style={{ animationDelay: "0.5s" }}
            />

            <div
              className="mb-6 anim-rise"
              style={{ animationDelay: "0.35s" }}
            >
              <CountdownTimer targetRace={nextRace} />
            </div>

            {upcomingSessions.length > 0 && (
              <div
                className="flex flex-wrap items-center gap-4 anim-rise"
                style={{ animationDelay: "0.5s" }}
              >
                <span className="font-semibold text-[13px] text-warm-300">
                  Next session
                </span>
                <div className="flex flex-wrap gap-2">
                  {upcomingSessions.map((s, i) => (
                    <span
                      key={s.id}
                      className={`text-xs px-[14px] py-2 rounded-[10px] ${
                        i === 0
                          ? "font-bold bg-[rgba(255,90,31,0.16)] text-[#FFAE6A]"
                          : "font-semibold bg-[rgba(245,235,222,0.05)] text-warm-200"
                      }`}
                    >
                      {s.sessionLabel} ·{" "}
                      <LocalDateTime
                        timestampMs={s.startTimeMs}
                        options={{
                          weekday: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        }}
                      />
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right — This season stat card */}
          <TiltCard
            className="apex-glass apex-sheen rounded-[22px] p-7 anim-rise min-w-0 overflow-hidden"
            strength={5}
          >
            <div className="relative">
              <div className="flex items-center justify-between gap-2 mb-6">
                <span className="font-bold text-[13px] truncate">
                  This season
                </span>
                <span className="font-semibold text-[11px] tracking-[0.06em] text-warm-500 uppercase whitespace-nowrap flex-none">
                  {done} / {total} rounds
                </span>
              </div>
              <div className="flex justify-around mb-6">
                {[
                  {
                    label: "Elapsed",
                    center: `${Math.round(elapsedPct * 100)}%`,
                    offset: RING * (1 - elapsedPct),
                    color: "#FF5A1F",
                  },
                  {
                    label: "Pt gap",
                    center: `${ptsGap}`,
                    offset: RING * (1 - gapPct),
                    color: "#c9c0b4",
                  },
                ].map((ring) => (
                  <AnimatedRing
                    key={ring.label}
                    center={ring.center}
                    label={ring.label}
                    offset={ring.offset}
                    color={ring.color}
                  />
                ))}
              </div>
              <div>
                {[
                  { k: "Leader wins", v: leaderWins },
                  { k: "Rounds completed", v: `${done} / ${total}` },
                  { k: "Rounds remaining", v: roundsLeft },
                ].map((row) => (
                  <div
                    key={row.k}
                    className="flex justify-between py-[11px] border-t border-[rgba(245,235,222,0.07)] font-semibold text-[13px]"
                  >
                    <span className="text-warm-300">{row.k}</span>
                    <span className="tabular-nums">{row.v}</span>
                  </div>
                ))}
              </div>
            </div>
          </TiltCard>
        </div>
      </section>

      {/* ===================== BENTO ===================== */}
      <section className="px-6 md:px-10 [perspective:1200px]">
        <Stagger className="grid md:grid-cols-3 gap-5" gap={0.08}>
          {/* Championship leader */}
          <StaggerItem>
          <TiltCard className="apex-glass apex-sheen rounded-[22px] p-[26px] overflow-hidden min-h-[224px] block h-full">
            <BentoDriverArt
              given={leader?.Driver.givenName}
              family={leader?.Driver.familyName}
              accent
            />
            <div className="relative max-w-[62%]">
              <span className="font-bold text-[11px] tracking-[0.14em] uppercase text-[#FF7A3D]">
                Championship leader
              </span>
              <div className="font-[family-name:var(--font-headline)] font-bold text-[21px] leading-[1.05] my-[14px] mb-[3px]">
                {leaderName || "TBC"}
              </div>
              <div className="font-semibold text-xs text-warm-400">
                {leaderTeam || "—"}
              </div>
              <div className="mt-5 flex items-baseline gap-2">
                {leaderPts ? (
                  <AnimatedNumber
                    value={leaderPts}
                    className="font-extrabold text-[44px] leading-none tabular-nums"
                  />
                ) : (
                  <span className="font-extrabold text-[44px] leading-none tabular-nums">
                    —
                  </span>
                )}
                <span className="font-semibold text-[11px] tracking-[0.08em] uppercase text-warm-500">
                  Pts
                </span>
              </div>
            </div>
          </TiltCard>
          </StaggerItem>

          {/* Last time out */}
          <StaggerItem>
          <TiltCard className="apex-glass apex-sheen rounded-[22px] p-[26px] overflow-hidden min-h-[224px] block h-full">
            <BentoDriverArt
              given={latestWinner?.givenName}
              family={latestWinner?.familyName}
            />
            <div className="relative max-w-[62%]">
              <span className="font-bold text-[11px] tracking-[0.14em] uppercase text-warm-300">
                Last time out
              </span>
              <div className="font-[family-name:var(--font-headline)] font-bold text-[21px] leading-[1.05] my-[14px] mb-[3px]">
                {latestWinner?.name || "TBC"}
              </div>
              <div className="font-semibold text-xs text-warm-400">
                {latestWinner
                  ? `${latestWinner.raceName.replace(" Grand Prix", " GP")} · Win`
                  : "—"}
              </div>
              {latestWinner?.time && (
                <div className="mt-[22px] inline-flex items-center gap-2 bg-[rgba(255,90,31,0.12)] rounded-[10px] px-[13px] py-[9px]">
                  <span
                    className="w-[6px] h-[6px] rounded-full"
                    style={{ background: winnerColor.hex }}
                  />
                  <span className="font-bold text-sm text-[#FFAE6A] tabular-nums">
                    {latestWinner.time}
                  </span>
                </div>
              )}
            </div>
          </TiltCard>
          </StaggerItem>

          {/* Next circuit */}
          <StaggerItem>
          <TiltCard
            href={
              nextRace
                ? `/schedule/${seasonYear}/${nextRace.round}`
                : "/circuits"
            }
            className="apex-glass apex-sheen rounded-[22px] p-[26px] overflow-hidden min-h-[224px] block h-full"
            ariaLabel="Next circuit"
          >
            <span className="relative font-bold text-[11px] tracking-[0.14em] uppercase text-[#FF7A3D]">
              Next circuit
            </span>
            <TrackMap
              src={circuitImg}
              alt={heroCircuit ?? "Circuit"}
              containerClassName="relative my-4 h-[100px] rounded-[14px]"
              imgClassName="object-contain p-3 opacity-80"
            />
            <div className="relative flex justify-between">
              <div>
                <div className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500">
                  Circuit
                </div>
                <div className="font-[family-name:var(--font-headline)] font-bold text-base mt-1">
                  {heroCircuit?.split(" ").slice(0, 2).join(" ") ?? "TBC"}
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500">
                  Country
                </div>
                <div className="font-[family-name:var(--font-headline)] font-bold text-base mt-1">
                  {nextRaceCountry || "TBC"}
                </div>
              </div>
            </div>
          </TiltCard>
          </StaggerItem>
        </Stagger>
      </section>

      {/* ===================== EXPLORE ===================== */}
      <section className="px-6 md:px-10 pt-10 pb-14">
        <Reveal className="flex items-baseline justify-between mb-5">
          <span className="font-[family-name:var(--font-headline)] font-bold text-[19px]">
            Explore the season
          </span>
        </Reveal>
        <Stagger className="grid grid-cols-2 lg:grid-cols-4 gap-4" gap={0.06}>
          {[
            { href: "/schedule", kicker: "Race calendar", big: `${total || 22}`, small: "races" },
            { href: "/standings", kicker: "Championship", title: "Standings" },
            { href: "/drivers", kicker: "Driver grid", big: `${driverStandings.length || 22}`, small: "drivers" },
            { href: "/teams", kicker: "Constructors", title: "Teams", accent: true },
          ].map((c) => (
            <StaggerItem key={c.href}>
            <Link
              href={c.href}
              className="apex-glass-soft rounded-2xl p-[22px] flex flex-col gap-[14px] h-full transition-[transform,border-color] duration-200 hover:-translate-y-1 hover:border-[rgba(255,138,61,0.45)]"
            >
              <span className="font-semibold text-[11px] tracking-[0.12em] uppercase text-warm-400">
                {c.kicker}
              </span>
              {c.big ? (
                <span className="font-extrabold text-2xl tabular-nums">
                  {c.big}{" "}
                  <span className="text-[15px] font-semibold text-warm-300">
                    {c.small}
                  </span>
                </span>
              ) : (
                <span
                  className={`font-[family-name:var(--font-headline)] font-bold text-xl ${
                    c.accent ? "text-[#FFAE6A]" : ""
                  }`}
                >
                  {c.title}
                </span>
              )}
            </Link>
            </StaggerItem>
          ))}
        </Stagger>
      </section>
    </>
  );
}

/**
 * Right-side driver artwork inside a bento card — the real cutout when we have
 * one, otherwise the APEX hatch placeholder. `accent` tints the placeholder
 * flame-orange to mark the championship leader.
 */
function BentoDriverArt({
  given,
  family,
  accent = false,
}: {
  given?: string;
  family?: string;
  accent?: boolean;
}) {
  const hasImg = given && family && hasDriverImage(given, family);
  const imgPath = hasImg ? getDriverImagePath(given!, family!) : null;

  if (imgPath) {
    return (
      <div className="absolute top-0 right-0 bottom-0 w-[46%] pointer-events-none">
        <Image
          src={imgPath}
          alt={`${given} ${family}`}
          fill
          sizes="200px"
          className="object-contain object-bottom drop-shadow-[0_10px_30px_rgba(0,0,0,0.7)]"
        />
      </div>
    );
  }

  return (
    <div
      className={`absolute top-6 right-6 bottom-6 w-[98px] rounded-[14px] flex items-end justify-center pb-[10px] ${
        accent ? "apex-hatch-flame" : "apex-hatch"
      }`}
    >
      <span
        className={`font-semibold text-[8px] tracking-[0.08em] text-center leading-tight ${
          accent ? "text-[#7a5a45]" : "text-warm-500"
        }`}
      >
        // DRIVER
        <br />
        CUTOUT
      </span>
    </div>
  );
}

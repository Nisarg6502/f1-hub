import Link from "next/link";
import Image from "next/image";
import {
  getActiveSeasonYear,
  getDriverStandings,
  getSeasonRaces,
  getRaceResults,
} from "@/lib/api";
import CountdownTimer from "@/components/countdown-timer";
import SessionCountdownCards from "@/components/session-countdown-cards";
import LocalDateTime from "@/components/local-datetime";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { getCircuitImagePath } from "@/lib/circuit-images";
import {
  buildRaceSessionTimeline,
  getNextSession,
} from "@/lib/sessions";

// Rendered per request. This page picks the next race by comparing the schedule
// against the current time, so a prerender goes stale the moment its target
// race is run — and on Cloud Run a cold container serves the build-time HTML,
// which is how the countdown ends up frozen at zero.
export const dynamic = "force-dynamic";

export default async function Home() {
  const seasonYear = getActiveSeasonYear();

  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"] = [];
  let driverStandings: Awaited<ReturnType<typeof getDriverStandings>>["driver_standings"] = [];

  try {
    const [racesRes, driverStandingsRes] =
      await Promise.all([
        getSeasonRaces(seasonYear),
        getDriverStandings(seasonYear),
      ]);

    races = racesRes.races ?? [];
    driverStandings = driverStandingsRes.driver_standings ?? [];
  } catch {
    // Backend is offline — render with empty data
  }

  // Find next upcoming race
  const now = new Date();
  const upcoming = races
    .map((race) => {
      if (!race.date) return null;
      const baseTime = race.time ?? "12:00:00Z";
      const iso = baseTime.endsWith("Z")
        ? `${race.date}T${baseTime}`
        : `${race.date}T${baseTime}Z`;
      const parsed = new Date(iso);
      const ts = parsed.getTime();
      if (Number.isNaN(ts)) return null;
      return { race, timestamp: ts };
    })
    .filter(
      (
        r
      ): r is {
        race: (typeof races)[number];
        timestamp: number;
      } => !!r
    )
    .filter((r) => r.timestamp > now.getTime())
    .sort((a, b) => a.timestamp - b.timestamp)[0]?.race;

  const nextRace = upcoming ?? races.find((r) => r.date) ?? races.at(-1);

  // Find the latest completed race for "Latest Race Winner"
  const completedRaces = races
    .map((race) => {
      if (!race.date) return null;
      const baseTime = race.time ?? "12:00:00Z";
      const iso = baseTime.endsWith("Z")
        ? `${race.date}T${baseTime}`
        : `${race.date}T${baseTime}Z`;
      const parsed = new Date(iso);
      const ts = parsed.getTime();
      if (Number.isNaN(ts)) return null;
      return { race, timestamp: ts };
    })
    .filter(
      (
        r
      ): r is {
        race: (typeof races)[number];
        timestamp: number;
      } => !!r
    )
    .filter((r) => r.timestamp <= now.getTime())
    .sort((a, b) => b.timestamp - a.timestamp);

  const latestCompletedRace = completedRaces[0]?.race;

  // Try to get the latest race results
  let latestWinner: { name: string; team: string; raceName: string; time: string; givenName: string; familyName: string } | null = null;
  if (latestCompletedRace) {
    try {
      const res = await getRaceResults(seasonYear, Number(latestCompletedRace.round));
      const results = res.results ?? [];
      if (results.length > 0) {
        const winner = results[0];
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
      // Silently fail
    }
  }

  const championshipLeader = driverStandings[0];

  // Derive the country name for hero
  const nextRaceCountry =
    nextRace?.Circuit?.Location?.country ?? "";
  const heroRaceName = nextRace?.raceName ?? "NEXT GRAND PRIX";
  const nextRaceSessions = buildRaceSessionTimeline(nextRace);
  const miniSessionCards = nextRaceSessions
    .filter((session) => session.sessionField !== "Race")
    .filter((session) => session.endTimeMs > now.getTime())
    .slice(0, 3);
  const nextWeekendSession = getNextSession(nextRaceSessions, now.getTime());

  return (
    <>
      {/* Hero Section */}
      <section className="relative min-h-[716px] flex flex-col items-center justify-center px-6 overflow-hidden motion-blur-bg">
        {/* Decorative Streaks */}
        <div className="light-streak w-[200%] top-1/4 -left-1/2 rotate-[-15deg]" />
        <div className="light-streak w-[200%] top-2/3 -left-1/4 rotate-[-10deg] opacity-20" />

        <div className="relative z-10 text-center">
          <h2 className="text-tertiary-container font-[family-name:var(--font-label)] text-sm md:text-base tracking-[0.4em] uppercase mb-4 opacity-80">
            Next Destination
          </h2>
          <h1 className="text-6xl md:text-9xl font-black font-[family-name:var(--font-headline)] text-on-background italic skew-x-[-12deg] tracking-tighter leading-none mb-8">
            {heroRaceName
              .replace(" Grand Prix", "")
              .toUpperCase()
              .split(" ")
              .slice(0, -2)
              .join(" ") || heroRaceName.replace(" Grand Prix", "").toUpperCase()}{" "}
            <span className="text-primary-container drop-shadow-[0_0_15px_#00f2ff]">
              GRAND PRIX
            </span>
          </h1>
          <CountdownTimer targetRace={nextRace} />
          {nextWeekendSession && (
            <p className="mt-4 text-xs uppercase tracking-[0.2em] text-on-surface-variant font-label">
              Next session: {nextWeekendSession.sessionLabel} ·{" "}
              <LocalDateTime timestampMs={nextWeekendSession.startTimeMs} />
            </p>
          )}
          <SessionCountdownCards sessions={miniSessionCards} />
        </div>
      </section>

      {/* Glance Bento Grid */}
      <section className="max-w-[1400px] mx-auto px-8 -mt-20 relative z-20">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Championship Leader Card */}
          <div className="glass-card group overflow-hidden relative p-0 transition-all hover:translate-y-[-4px] border-t-2 border-t-primary-container">
            {/* Background number */}
            <span className="absolute -right-4 -bottom-6 font-[family-name:var(--font-headline)] font-black text-[180px] italic text-white/[0.03] select-none pointer-events-none leading-none">
              {championshipLeader?.Driver?.permanentNumber ?? ""}
            </span>

            <div className="relative z-10 p-8 flex flex-col justify-between min-h-[320px]">
              <p className="font-[family-name:var(--font-label)] text-[10px] tracking-[0.3em] text-primary-container uppercase mb-4">
                Championship Leader
              </p>
              <div>
                <h3 className="text-3xl font-black font-[family-name:var(--font-headline)] italic skew-x-[-12deg] tracking-tighter uppercase">
                  {championshipLeader
                    ? `${championshipLeader.Driver.givenName} ${championshipLeader.Driver.familyName}`
                    : "TBC"}
                </h3>
                <div className="flex items-center gap-3 mt-2">
                  <span className="font-[family-name:var(--font-label)] text-sm tracking-widest text-on-surface-variant uppercase">
                    {championshipLeader?.Constructors?.[0]?.name ?? "—"}
                  </span>
                </div>
                <div className="mt-4 flex items-baseline gap-2">
                  <span className="text-5xl font-black font-[family-name:var(--font-headline)] tabular-nums text-primary-container">
                    {championshipLeader?.points ?? "—"}
                  </span>
                  <span className="text-xs font-[family-name:var(--font-label)] tracking-widest opacity-50 uppercase">
                    Points
                  </span>
                </div>
              </div>
            </div>

            {/* Driver image overlay */}
            {championshipLeader && hasDriverImage(championshipLeader.Driver.givenName, championshipLeader.Driver.familyName) && (
              <div className="absolute bottom-0 right-0 w-[55%] h-full pointer-events-none">
                <Image
                  src={getDriverImagePath(championshipLeader.Driver.givenName, championshipLeader.Driver.familyName)!}
                  alt={`${championshipLeader.Driver.givenName} ${championshipLeader.Driver.familyName}`}
                  fill
                  className="object-contain object-bottom opacity-60 group-hover:opacity-80 group-hover:scale-105 transition-all duration-700 drop-shadow-[0_0_20px_rgba(0,0,0,0.8)]"
                />
              </div>
            )}
          </div>

          {/* Latest Race Winner Card */}
          <div className="glass-card group overflow-hidden relative p-0 transition-all hover:translate-y-[-4px] border-t-2 border-t-secondary-container">
            <div className="relative z-10 p-8 flex flex-col justify-between min-h-[320px]">
              <p className="font-[family-name:var(--font-label)] text-[10px] tracking-[0.3em] text-secondary-container uppercase mb-4">
                Latest Race Winner
              </p>
              <div>
                <h3 className="text-3xl font-black font-[family-name:var(--font-headline)] italic skew-x-[-12deg] tracking-tighter uppercase">
                  {latestWinner?.name ?? "TBC"}
                </h3>
                <p className="text-xs font-[family-name:var(--font-label)] tracking-widest text-on-surface-variant uppercase mb-4">
                  {latestWinner?.raceName ?? "—"}
                </p>
                {latestWinner?.time && (
                  <div className="inline-block px-3 py-1 bg-secondary-container/20 border border-secondary-container/30 text-secondary-container text-[10px] font-bold tracking-widest uppercase">
                    {latestWinner.time}
                  </div>
                )}
              </div>
            </div>

            {/* Driver image overlay */}
            {latestWinner && hasDriverImage(latestWinner.givenName, latestWinner.familyName) && (
              <div className="absolute bottom-0 right-0 w-[50%] h-full pointer-events-none">
                <Image
                  src={getDriverImagePath(latestWinner.givenName, latestWinner.familyName)!}
                  alt={latestWinner.name}
                  fill
                  className="object-contain object-bottom opacity-50 group-hover:opacity-75 group-hover:scale-105 transition-all duration-700 drop-shadow-[0_0_20px_rgba(0,0,0,0.8)]"
                />
              </div>
            )}
          </div>

          {/* Track Info Card */}
          <Link 
            href={nextRace ? `/schedule/${seasonYear}/${nextRace.round}` : "/schedule"}
            className="glass-card group overflow-hidden relative p-8 transition-all hover:translate-y-[-4px] border-t-2 border-t-tertiary-container block"
          >
            <p className="font-[family-name:var(--font-label)] text-[10px] tracking-[0.3em] text-tertiary-container uppercase mb-6">
              Next Race Circuit
            </p>
            <div className="flex flex-col items-center justify-center flex-1">
              <div className="relative w-full aspect-square max-h-48 mb-6 flex items-center justify-center">
                {(() => {
                  const circuitImg = getCircuitImagePath(nextRaceCountry, nextRace?.Circuit?.Location?.locality, nextRace?.Circuit?.circuitName);
                  return circuitImg ? (
                    <Image
                      src={circuitImg}
                      alt="Circuit Layout"
                      fill
                      className="object-contain opacity-50 group-hover:opacity-100 transition-all duration-700 invert brightness-0 dark:invert-0 dark:brightness-100"
                    />
                  ) : (
                    <span className="material-symbols-outlined text-4xl text-tertiary-container animate-pulse">
                      location_on
                    </span>
                  );
                })()}
              </div>
              <div className="w-full grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[10px] font-[family-name:var(--font-label)] text-on-surface-variant tracking-widest uppercase">
                    Circuit
                  </p>
                  <p className="font-bold text-lg font-[family-name:var(--font-headline)] italic skew-x-[-12deg]">
                    {nextRace?.Circuit?.circuitName?.split(" ").slice(0, 2).join(" ") ?? "TBC"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-[family-name:var(--font-label)] text-on-surface-variant tracking-widest uppercase">
                    Country
                  </p>
                  <p className="font-bold text-lg font-[family-name:var(--font-headline)] italic skew-x-[-12deg]">
                    {nextRaceCountry || "TBC"}
                  </p>
                </div>
              </div>
            </div>
          </Link>
        </div>
      </section>

      {/* Quick Links / Telemetry Section */}
      <section className="max-w-[1400px] mx-auto px-8 mt-24">
        <div className="flex justify-between items-end mb-8">
          <div>
            <h2 className="text-4xl font-black font-[family-name:var(--font-headline)] italic skew-x-[-12deg] tracking-tighter uppercase">
              Season Overview
            </h2>
            <p className="text-xs font-[family-name:var(--font-label)] tracking-widest text-on-surface-variant uppercase mt-1">
              Quick access to all sections
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Link
            href="/schedule"
            className="bg-surface-container-low p-6 flex flex-col gap-4 group hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-primary-container text-3xl">
              schedule
            </span>
            <p className="font-[family-name:var(--font-label)] text-[10px] tracking-[0.2em] uppercase opacity-60">
              Race Calendar
            </p>
            <p className="font-[family-name:var(--font-headline)] font-bold italic text-lg">
              {races.length} RACES
            </p>
          </Link>

          <Link
            href="/standings"
            className="bg-surface-container-low p-6 flex flex-col gap-4 group hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-secondary-container text-3xl">
              leaderboard
            </span>
            <p className="font-[family-name:var(--font-label)] text-[10px] tracking-[0.2em] uppercase opacity-60">
              Championship
            </p>
            <p className="font-[family-name:var(--font-headline)] font-bold italic text-lg">
              STANDINGS
            </p>
          </Link>

          <Link
            href="/drivers"
            className="bg-surface-container-low p-6 flex flex-col gap-4 group hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-tertiary-container text-3xl">
              person
            </span>
            <p className="font-[family-name:var(--font-label)] text-[10px] tracking-[0.2em] uppercase opacity-60">
              Driver Grid
            </p>
            <p className="font-[family-name:var(--font-headline)] font-bold italic text-lg">
              {driverStandings.length} DRIVERS
            </p>
          </Link>

          <Link
            href="/circuits"
            className="bg-surface-container-low p-6 flex flex-col gap-4 group hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-primary-container text-3xl">
              route
            </span>
            <p className="font-[family-name:var(--font-label)] text-[10px] tracking-[0.2em] uppercase opacity-60">
              World Tour
            </p>
            <p className="font-[family-name:var(--font-headline)] font-bold italic text-lg">
              CIRCUITS
            </p>
          </Link>
        </div>
      </section>

      {/* Telemetry Preview Bars */}
      <section className="max-w-[1400px] mx-auto px-8 mt-16 mb-12">
        <div className="flex justify-between items-end mb-8">
          <div>
            <h2 className="text-4xl font-black font-[family-name:var(--font-headline)] italic skew-x-[-12deg] tracking-tighter uppercase">
              Live Telemetry
            </h2>
            <p className="text-xs font-[family-name:var(--font-label)] tracking-widest text-on-surface-variant uppercase mt-1">
              Real-time data from sector 3
            </p>
          </div>
          <Link
            href="/standings"
            className="text-primary-container font-[family-name:var(--font-label)] text-[10px] tracking-widest uppercase border-b border-primary-container pb-1 hover:opacity-70 transition-opacity"
          >
            Full Data Stack
          </Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { label: "Engine Load", value: "85%", width: "85%", color: "primary-container" },
            { label: "Tire Temp (S)", value: "112°C", width: "62%", color: "secondary-container" },
            { label: "Fuel Density", value: "34%", width: "34%", color: "tertiary-container" },
            { label: "G-Force (Lat)", value: "4.8G", width: "92%", color: "primary-container" },
          ].map((item) => (
            <div
              key={item.label}
              className="bg-surface-container-low p-6 flex flex-col gap-4"
            >
              <p className="font-[family-name:var(--font-label)] text-[10px] tracking-[0.2em] uppercase opacity-60">
                {item.label}
              </p>
              <div className="h-12 bg-neutral-900 overflow-hidden relative skew-x-[-12deg]">
                <div
                  className={`h-full bg-gradient-to-r from-${item.color}/20 to-${item.color}`}
                  style={{ width: item.width }}
                />
                <div className="absolute inset-0 flex items-center justify-end px-4">
                  <span className="font-[family-name:var(--font-headline)] font-bold text-xl italic">
                    {item.value}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

import Link from "next/link";
import Image from "next/image";
import { getActiveSeasonYear, getSeasonRaces } from "@/lib/api";
import { getCountryFlagPath } from "@/lib/flags";
import RaceWeather from "@/components/race-weather";

// Rendered per request: this page splits the calendar into past and upcoming
// against the current time, which a prerender cannot keep correct.
export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const year = getActiveSeasonYear();
  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"] = [];
  try {
    const racesRes = await getSeasonRaces(year);
    races = racesRes.races ?? [];
  } catch {
    // Backend offline
  }

  const now = new Date();

  // Build enriched race items
  const raceItems = races.map((race) => {
    let date: Date | null = null;
    if (race.date) {
      const baseTime = race.time ?? "12:00:00Z";
      const iso = baseTime.endsWith("Z")
        ? `${race.date}T${baseTime}`
        : `${race.date}T${baseTime}Z`;
      const parsed = new Date(iso);
      if (!Number.isNaN(parsed.getTime())) {
        date = parsed;
      }
    }
    const isPast = date ? date.getTime() < now.getTime() : false;

    // Detect sprint weekend
    const raceAny = race as any;
    const isSprint = !!(raceAny.Sprint?.date || raceAny.SprintQualifying?.date);

    return { race, date, isPast, isSprint };
  });

  // Find next upcoming
  const nextUpcoming = raceItems.find((r) => !r.isPast);

  return (
    <>
      {/* Hero Header */}
      <header className="pt-8 pb-12 px-8 max-w-[1920px] mx-auto relative overflow-hidden grid-bg">
        <div className="relative z-10">
          <h1 className="text-6xl md:text-8xl font-black font-[family-name:var(--font-headline)] italic skew-heading uppercase tracking-tighter text-on-surface">
            Race <span className="text-primary-container">Schedule</span>
          </h1>
          <p className="mt-4 font-[family-name:var(--font-label)] text-neutral-400 tracking-[0.2em] uppercase text-sm">
            {year} FIA Formula One World Championship
          </p>
        </div>
        <div className="absolute bottom-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary-container to-transparent opacity-30" />
      </header>

      <div className="px-8 py-6 max-w-[1920px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-12">
        {/* Sidebar */}
        <aside className="lg:col-span-3 space-y-8">
          <div className="space-y-4">
            <h3 className="font-[family-name:var(--font-label)] text-xs font-bold text-neutral-500 tracking-widest uppercase">
              Season Phase
            </h3>
            <div className="flex flex-col space-y-2">
              <button className="flex items-center justify-between p-4 bg-surface-container-high border-l-2 border-primary-container group transition-all duration-300">
                <span className="font-[family-name:var(--font-headline)] font-bold text-lg italic">
                  UPCOMING RACES
                </span>
                <span className="material-symbols-outlined text-primary-container">
                  arrow_forward_ios
                </span>
              </button>
              <button className="flex items-center justify-between p-4 bg-surface-container opacity-50 hover:opacity-100 transition-all duration-300">
                <span className="font-[family-name:var(--font-headline)] font-bold text-lg italic">
                  COMPLETED
                </span>
                <span className="material-symbols-outlined text-neutral-500">
                  history
                </span>
              </button>
            </div>
          </div>

          {/* Next Event Card */}
          {nextUpcoming && (
            <div className="glass-card p-6 border-t-2 border-secondary-container">
              <h3 className="font-[family-name:var(--font-label)] text-xs font-bold text-secondary tracking-widest uppercase mb-4">
                Next Event
              </h3>
              <div className="space-y-4">
                <div>
                  <h4 className="font-[family-name:var(--font-headline)] text-2xl font-bold italic text-on-surface">
                    {nextUpcoming.race.raceName}
                  </h4>
                  <p className="text-neutral-400 text-sm">
                    {nextUpcoming.race.Circuit?.circuitName}
                  </p>
                </div>
                {nextUpcoming.date && (
                  <div className="flex items-baseline space-x-2 font-[family-name:var(--font-headline)] italic">
                    <span className="text-4xl font-black text-primary-container">
                      {String(
                        Math.max(
                          0,
                          Math.floor(
                            (nextUpcoming.date.getTime() - now.getTime()) /
                              86400000
                          )
                        )
                      ).padStart(2, "0")}
                    </span>
                    <span className="text-xs text-neutral-500 uppercase tracking-widest">
                      Days
                    </span>
                    <span className="text-4xl font-black text-primary-container">
                      {String(
                        Math.max(
                          0,
                          Math.floor(
                            ((nextUpcoming.date.getTime() - now.getTime()) %
                              86400000) /
                              3600000
                          )
                        )
                      ).padStart(2, "0")}
                    </span>
                    <span className="text-xs text-neutral-500 uppercase tracking-widest">
                      Hrs
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>

        {/* Main Timeline */}
        <section className="lg:col-span-9">
          <div className="flex flex-col space-y-6">
            {raceItems.map(({ race, date, isPast, isSprint }) => {
              const circuit = race.Circuit;
              const location = circuit?.Location;
              const country = location?.country ?? "";
              const flagSrc = getCountryFlagPath(country);
              const dateStr = date
                ? date.toLocaleDateString(undefined, {
                    day: "2-digit",
                    month: "short",
                  })
                : "TBC";

              const isNext = race.round === nextUpcoming?.race.round;

              // Build session schedule for the next race
              const raceAny = race as any;
              const sessions: {
                label: string;
                date: Date;
                highlight?: boolean;
              }[] = [];

              if (isNext) {
                const sessionDefs = [
                  { key: "FirstPractice", label: "FP1" },
                  { key: "SecondPractice", label: "FP2" },
                  { key: "ThirdPractice", label: "FP3" },
                  {
                    key: "SprintQualifying",
                    label: isSprint ? "SPRINT SHOOTOUT" : "Sprint Quali",
                  },
                  { key: "Sprint", label: "SPRINT" },
                  { key: "Qualifying", label: "QUALIFYING" },
                ];
                for (const sd of sessionDefs) {
                  const sessionData = raceAny[sd.key];
                  if (sessionData?.date) {
                    const t = sessionData.time ?? "12:00:00Z";
                    const iso = t.endsWith("Z")
                      ? `${sessionData.date}T${t}`
                      : `${sessionData.date}T${t}Z`;
                    const parsed = new Date(iso);
                    if (!Number.isNaN(parsed.getTime())) {
                      sessions.push({
                        label: sd.label,
                        date: parsed,
                        highlight:
                          sd.key === "Qualifying" || sd.key === "Sprint",
                      });
                    }
                  }
                }
                // Race session itself
                if (date) {
                  sessions.push({
                    label: "RACE",
                    date: date,
                    highlight: true,
                  });
                }
              }

              return (
                <Link
                  key={`${race.round}-${race.raceName}`}
                  href={`/schedule/${race.season ?? year}/${race.round}`}
                  className="block"
                >
                  <div
                    className={`group relative transition-all duration-500 ${
                      isPast
                        ? "bg-surface-container-lowest/50 opacity-40 hover:opacity-70"
                        : isNext
                        ? "glass-card border-l-4 border-primary-container shadow-[20px_0_40px_rgba(0,242,255,0.05)] hover:translate-x-2 hover:shadow-[20px_0_60px_rgba(0,242,255,0.1)]"
                        : "glass-card border-l-4 border-neutral-700 hover:border-secondary-container hover:translate-x-2 hover:shadow-[10px_0_30px_rgba(0,242,255,0.04)]"
                    }`}
                  >
                    {/* Main row */}
                    <div className="flex flex-col md:flex-row">
                      {/* Date */}
                      <div className="md:w-48 p-6 flex flex-col justify-center border-r border-neutral-800">
                        <span
                          className={`font-[family-name:var(--font-label)] text-[10px] tracking-widest uppercase ${
                            isNext
                              ? "text-primary-container font-bold"
                              : "text-neutral-500"
                          }`}
                        >
                          Round {race.round}
                        </span>
                        <span className="font-[family-name:var(--font-headline)] font-bold text-2xl italic text-on-surface">
                          {dateStr.toUpperCase()}
                        </span>
                      </div>

                      {/* Race Info */}
                      <div className="flex-grow p-6 flex flex-col md:flex-row md:items-center justify-between">
                        <div className="flex items-center space-x-5">
                          {/* Country Flag */}
                          <div className="w-12 h-8 bg-surface-container flex items-center justify-center overflow-hidden flex-shrink-0 border border-neutral-800">
                            {flagSrc ? (
                              <Image
                                src={flagSrc}
                                alt={country}
                                width={48}
                                height={32}
                                className="object-cover w-full h-full"
                              />
                            ) : (
                              <span className="material-symbols-outlined text-neutral-600">
                                flag
                              </span>
                            )}
                          </div>
                          <div>
                            <h3
                              className={`font-[family-name:var(--font-headline)] font-bold text-xl uppercase tracking-tight ${
                                isPast ? "text-neutral-400" : "text-on-surface"
                              }`}
                            >
                              {race.raceName}
                            </h3>
                            <p className="text-xs text-neutral-400">
                              {circuit?.circuitName}
                              {location?.locality
                                ? ` · ${location.locality}, ${location.country}`
                                : ""}
                            </p>
                          </div>
                        </div>
                        <div className="mt-4 md:mt-0 flex items-center gap-3">
                          {isSprint && !isPast && (
                            <span className="px-3 py-1 bg-primary-container/20 border border-primary-container/40 text-primary-container text-[10px] font-[family-name:var(--font-label)] font-bold tracking-widest uppercase whitespace-nowrap">
                              Sprint Weekend
                            </span>
                          )}
                          {isPast ? (
                            <div className="flex items-center">
                              <span className="px-4 py-1 border border-neutral-800 text-[10px] font-[family-name:var(--font-label)] tracking-widest text-neutral-600 uppercase">
                                Completed
                              </span>
                              {race.date && <RaceWeather year={Number(race.season ?? year)} round={Number(race.round)} dateStr={race.date} />}
                            </div>
                          ) : isNext ? (
                            <span className="material-symbols-outlined text-primary-container group-hover:translate-x-1 transition-transform">
                              keyboard_double_arrow_right
                            </span>
                          ) : (
                            <span className="px-4 py-1 border border-neutral-700 text-[10px] font-[family-name:var(--font-label)] tracking-widest text-neutral-500 uppercase">
                              Upcoming
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Session timings — shown only for next race */}
                    {isNext && sessions.length > 0 && (
                      <div className="border-t border-neutral-800 px-6 py-4">
                        <div className="flex flex-wrap gap-x-8 gap-y-3 md:ml-48">
                          {sessions.map((s) => {
                            const isRace = s.label === "RACE";
                            const isHighlight = s.highlight;
                            return (
                              <div
                                key={s.label}
                                className={`flex flex-col items-center ${
                                  isRace
                                    ? "px-4 py-2 bg-primary-container/10 border border-primary-container/30"
                                    : isHighlight
                                    ? ""
                                    : ""
                                }`}
                              >
                                <span
                                  className={`text-[10px] font-[family-name:var(--font-label)] font-bold tracking-widest uppercase ${
                                    isRace || isHighlight
                                      ? "text-primary-container"
                                      : "text-neutral-500"
                                  }`}
                                >
                                  {s.label}
                                </span>
                                <span
                                  className={`font-[family-name:var(--font-headline)] font-bold text-xl italic ${
                                    isRace
                                      ? "text-primary-container"
                                      : isHighlight
                                      ? "text-primary-container"
                                      : "text-on-surface"
                                  }`}
                                >
                                  {s.date.toLocaleTimeString(undefined, {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    hour12: false,
                                  })}
                                </span>
                                <span className="text-[9px] text-neutral-500 tracking-wider uppercase">
                                  {s.date.toLocaleDateString(undefined, {
                                    weekday: "short",
                                    day: "2-digit",
                                    month: "short",
                                  })}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </>
  );
}

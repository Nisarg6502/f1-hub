import {
  getActiveSeasonYear,
  getSeasonRaces,
  getCircuitDetails,
} from "@/lib/api";
import { getCircuitImagePath } from "@/lib/circuit-images";
import CircuitsGallery from "@/components/circuits-gallery";
import TrackMap from "@/components/track-map";

// Circuit details are filled in by the sync job as the season runs, so this
// page must not be pinned to a build-time snapshot.
export const dynamic = "force-dynamic";

export default async function CircuitsPage() {
  const year = getActiveSeasonYear();
  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"] = [];
  let circuitDetails: Awaited<ReturnType<typeof getCircuitDetails>> = [];

  try {
    const [racesRes, details] = await Promise.all([
      getSeasonRaces(year),
      getCircuitDetails(year),
    ]);
    races = racesRes.races ?? [];
    circuitDetails = details ?? [];
  } catch {
    // Backend offline
  }

  // Feature the next upcoming round if we can find one, else the opener.
  const nowMs = Date.now();
  const featured =
    races.find((r) => {
      if (!r.date) return false;
      const t = new Date(
        `${r.date}T${r.time ?? "12:00:00Z"}`.replace(/Z?$/, "Z")
      ).getTime();
      return !Number.isNaN(t) && t > nowMs;
    }) ??
    races[0];

  const featuredImagePath = featured
    ? getCircuitImagePath(
        featured.Circuit?.Location?.country,
        featured.Circuit?.Location?.locality,
        featured.Circuit?.circuitName
      )
    : null;

  return (
    <div className="px-6 md:px-10 pt-10 pb-16">
      {/* Featured + DNA */}
      <section className="grid lg:grid-cols-[1fr_320px] gap-5 mb-10">
        <div className="apex-glass-strong apex-sheen rounded-[22px] overflow-hidden relative min-h-[340px] flex items-end">
          <TrackMap
            src={featuredImagePath}
            alt={featured?.Circuit?.circuitName ?? "Circuit"}
            containerClassName="absolute inset-0"
            imgClassName="object-contain p-14 opacity-80"
            labelClassName="font-semibold text-[11px] tracking-[0.16em] text-warm-600"
            sizes="(max-width: 1024px) 100vw, 900px"
          />
          <div className="relative z-10 p-8">
            <div className="flex flex-wrap items-center gap-2.5 mb-3">
              <span className="font-bold text-[10px] tracking-[0.12em] uppercase px-2.5 py-1.5 rounded-lg bg-[rgba(255,90,31,0.16)] text-[#FFAE6A]">
                Featured track
              </span>
              {featured && (
                <span className="font-semibold text-[11px] tracking-[0.08em] uppercase text-warm-400">
                  Round {featured.round} · {featured.Circuit?.Location?.locality}
                </span>
              )}
            </div>
            <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[44px] tracking-[-1px] leading-[0.98]">
              {featured?.Circuit?.circuitName ?? "World Circuits"}
            </h1>
          </div>
        </div>

        <div className="apex-glass apex-sheen rounded-[22px] p-[26px]">
          <div className="relative">
            <div className="font-[family-name:var(--font-headline)] font-bold text-base mb-5">
              Circuit DNA
            </div>
            <div className="flex flex-col">
              {[
                { label: "Total circuits", value: races.length || "—", num: true },
                { label: "Season", value: year, num: true },
                { label: "Opening round", value: races[0]?.raceName ?? "TBC" },
                {
                  label: "Featured country",
                  value: featured?.Circuit?.Location?.country ?? "TBC",
                },
              ].map((row) => (
                <div
                  key={row.label}
                  className="py-3.5 border-t border-[rgba(245,235,222,0.08)]"
                >
                  <div className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500">
                    {row.label}
                  </div>
                  <div
                    className={`mt-0.5 ${
                      row.num
                        ? "font-extrabold text-[22px] tabular-nums"
                        : "font-bold text-base"
                    }`}
                  >
                    {row.value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* World tour */}
      <div className="font-[family-name:var(--font-headline)] font-bold text-[19px] mb-1">
        World tour
      </div>
      <div className="font-medium text-[13px] text-warm-400 mb-[18px]">
        {races.length} destinations of peak performance — tap any track for
        detail
      </div>

      <CircuitsGallery races={races} circuitDetails={circuitDetails} />
    </div>
  );
}

import type { Metadata } from "next";
import {
  getActiveSeasonYear,
  getSeasonRaces,
  getCircuitDetails,
} from "@/lib/api";
import { getCircuitImagePath } from "@/lib/circuit-images";
import CircuitsGallery from "@/components/circuits-gallery";
import CircuitDnaCompare from "@/components/circuit-dna-compare";
import TrackMap from "@/components/track-map";
import DegradedBeacon from "@/components/degraded-beacon";

export const metadata: Metadata = {
  title: "Circuits | APEX",
  description:
    "Every circuit on the Formula 1 calendar: layout, corner count, lap record and elevation, with side-by-side circuit DNA comparison.",
};

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
  // A Server Component renders once per request with no re-render replay to
  // make this unstable — the purity rule guards Client Component render
  // bodies, which React Compiler can re-invoke; it has no such concern here.
  // eslint-disable-next-line react-hooks/purity
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
      {races.length === 0 && <DegradedBeacon route="/circuits" />}
      {/* Featured + DNA */}
      <section className="grid lg:grid-cols-[1fr_320px] gap-5 mb-10">
        <div className="apex-glass-strong apex-sheen rounded-panel overflow-hidden relative min-h-[340px] flex items-end">
          <TrackMap
            src={featuredImagePath}
            alt={featured?.Circuit?.circuitName ?? "Circuit"}
            containerClassName="absolute inset-0"
            imgClassName="object-contain p-14"
            labelClassName="font-semibold text-[11px] tracking-[0.16em] text-warm-600"
            sizes="(max-width: 1024px) 100vw, 900px"
          />
          <div className="relative z-10 p-8">
            <div className="flex flex-wrap items-center gap-2.5 mb-3">
              <span className="font-bold text-[10px] tracking-[0.12em] uppercase px-2.5 py-1.5 rounded-lg bg-primary-container/16 text-primary">
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

        <div className="apex-glass apex-sheen rounded-panel p-[26px]">
          <CircuitDnaCompare races={races} circuitDetails={circuitDetails} />
        </div>
      </section>

      {/* World tour */}
      <div className="font-[family-name:var(--font-headline)] font-bold text-[20px] mb-1">
        World tour
      </div>
      <div className="font-medium text-[13px] text-warm-400 mb-[18px]">
        {races.length} destinations of peak performance — tap any track for
        detail
      </div>

      <CircuitsGallery races={races} circuitDetails={circuitDetails} />

      {/* CC BY-SA 3.0 requires attribution — the Saudi Arabia (Jeddah) track
          outline is the only circuit asset under that license; the rest are
          public-domain/CC0 or original artwork. */}
      <p className="font-medium text-[10px] text-warm-500 mt-8">
        Jeddah Corniche Circuit outline via{" "}
        <a
          href="https://commons.wikimedia.org/wiki/File:Jeddah_Street_Circuit_2021.svg"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-warm-300"
        >
          Wikimedia Commons
        </a>
        , licensed{" "}
        <a
          href="https://creativecommons.org/licenses/by-sa/3.0/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-warm-300"
        >
          CC BY-SA 3.0
        </a>
        .
      </p>
    </div>
  );
}

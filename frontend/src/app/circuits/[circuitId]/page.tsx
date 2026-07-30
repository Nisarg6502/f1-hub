import Link from "next/link";
import { notFound } from "next/navigation";

import TrackViewer from "@/components/track3d/track-viewer-mount";
import { getActiveSeasonYear, getSeasonRaces } from "@/lib/api";
import { getCircuitImagePath } from "@/lib/circuit-images";
import { getTrackGeometryId } from "@/lib/circuit-geometry";

// Circuit metadata comes from the sync job as the season runs, so this must not
// be pinned to a build-time snapshot.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ circuitId: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { circuitId } = await params;
  return {
    title: `${circuitId} · 3D elevation · APEX`,
  };
}

export default async function CircuitDetailPage({ params }: PageProps) {
  const { circuitId } = await params;
  const geometryId = getTrackGeometryId(circuitId);
  if (!geometryId) notFound();

  const year = getActiveSeasonYear();
  type SeasonRace = NonNullable<
    Awaited<ReturnType<typeof getSeasonRaces>>["races"]
  >[number];
  let race: SeasonRace | undefined;
  try {
    const { races } = await getSeasonRaces(year);
    race = (races ?? []).find(
      (item) => item.Circuit?.circuitId?.toLowerCase() === circuitId.toLowerCase(),
    );
  } catch {
    // Backend offline — the viewer's data is static, so the page still works.
  }

  const circuit = race?.Circuit;
  const name = circuit?.circuitName ?? circuitId;
  const fallbackImage = getCircuitImagePath(
    circuit?.Location?.country,
    circuit?.Location?.locality,
    circuit?.circuitName,
  );

  return (
    <div className="px-6 md:px-10 pt-10 pb-16">
      <nav className="mb-5">
        <Link
          href="/circuits"
          className="font-semibold text-[11px] tracking-[0.1em] uppercase text-warm-500 hover:text-warm-300 transition-colors"
        >
          ← All circuits
        </Link>
      </nav>

      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-2.5 mb-3">
          <span className="font-bold text-[10px] tracking-[0.12em] uppercase px-2.5 py-1.5 rounded-lg bg-[rgba(255,90,31,0.16)] text-[#FFAE6A]">
            3D elevation
          </span>
          {race && (
            <span className="font-semibold text-[11px] tracking-[0.08em] uppercase text-warm-400">
              Round {race.round} · {circuit?.Location?.locality},{" "}
              {circuit?.Location?.country}
            </span>
          )}
        </div>
        <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[44px] tracking-[-1px] leading-[0.98]">
          {name}
        </h1>
        <p className="font-medium text-[13px] text-warm-400 mt-2 max-w-2xl">
          Rendered from the real circuit centreline and an open elevation model.
          Drag to orbit, scrub the profile to move the camera, or fly a corner.
        </p>
      </header>

      <TrackViewer
        geometryId={geometryId}
        fallbackImage={fallbackImage}
        circuitName={name}
      />

      <p className="font-medium text-[10px] text-warm-500 mt-8 max-w-3xl leading-relaxed">
        Centreline geometry from{" "}
        <a
          href="https://github.com/bacinger/f1-circuits"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-warm-300"
        >
          bacinger/f1-circuits
        </a>{" "}
        (MIT). Elevation sampled from{" "}
        <a
          href="https://www.opentopodata.org/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-warm-300"
        >
          OpenTopoData
        </a>{" "}
        — EU-DEM © European Union, NED courtesy of the U.S. Geological Survey, SRTM
        courtesy of NASA/USGS. Track widths and the optimal racing line from{" "}
        <a
          href="https://github.com/TUMFTM/racetrack-database"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-warm-300"
        >
          TUMFTM/racetrack-database
        </a>
        . Corner banking is curated from published figures — an elevation grid at
        25 m spacing cannot resolve camber across a 15 m road. Vertical
        exaggeration is applied by default and is always labelled on the viewer.
      </p>
    </div>
  );
}

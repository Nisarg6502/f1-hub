"use client";

import { useState } from "react";
import { type Race, type CircuitDetail } from "@/lib/api";
import { getCountryFlagPath } from "@/lib/flags";
import { getCircuitImagePath } from "@/lib/circuit-images";
import CircuitDetailsModal from "./circuit-details-modal";
import TrackMap from "./track-map";
import FlagImg from "./flag-img";

interface CircuitsGalleryProps {
  races: Race[];
  circuitDetails: CircuitDetail[];
}

// Rotating accent palette so the grid reads with variety.
const PALETTE = [
  "#FF5A1F",
  "#00D7B6",
  "#E80020",
  "#FF8000",
  "#3671C6",
  "#FF87BC",
  "#6692FF",
  "#64C4FF",
  "#229971",
  "#52E252",
  "#FFAE6A",
];

export default function CircuitsGallery({
  races,
  circuitDetails,
}: CircuitsGalleryProps) {
  const [selected, setSelected] = useState<{
    detail: CircuitDetail;
    circuitImagePath: string | null;
    flagPath: string | null;
  } | null>(null);

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {races.map((race, idx) => {
          const color = PALETTE[idx % PALETTE.length];
          const location = race.Circuit?.Location;
          const flagPath = getCountryFlagPath(location?.country);
          const circuitImagePath = getCircuitImagePath(
            location?.country,
            location?.locality,
            race.Circuit?.circuitName
          );
          const detail = circuitDetails.find(
            (c) => c.round === Number(race.round)
          );

          return (
            <button
              key={`${race.round}-${race.raceName}`}
              type="button"
              disabled={!detail}
              onClick={() =>
                detail &&
                setSelected({ detail, circuitImagePath, flagPath })
              }
              className={`text-left rounded-2xl overflow-hidden apex-glass-soft transition-all duration-200 ${
                detail
                  ? "cursor-pointer hover:-translate-y-1.5 hover:border-[rgba(255,138,61,0.4)]"
                  : "cursor-default"
              }`}
            >
              <div className="h-[3px]" style={{ background: color }} />
              <div className="p-[18px]">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-400 truncate">
                    {location?.locality ?? `Round ${race.round}`}
                  </span>
                  <span className="w-[26px] h-[18px] rounded overflow-hidden flex items-center justify-center bg-[rgba(245,235,222,0.08)] flex-none">
                    <FlagImg
                      src={flagPath}
                      alt={location?.country ?? ""}
                      width={26}
                      height={18}
                      className="object-cover w-full h-full"
                    />
                  </span>
                </div>
                <div className="font-[family-name:var(--font-headline)] font-bold text-base leading-[1.1] min-h-[44px]">
                  {race.Circuit?.circuitName ??
                    race.raceName.replace(" Grand Prix", "")}
                </div>
                <TrackMap
                  src={circuitImagePath}
                  alt={`${race.Circuit?.circuitName ?? "circuit"} layout`}
                  containerClassName="my-3.5 h-[70px] rounded-[10px]"
                  imgClassName="object-contain p-2 opacity-70"
                  labelClassName="font-semibold text-[8px] tracking-[0.1em] text-warm-600"
                  sizes="(max-width: 640px) 45vw, 300px"
                />
                <div className="flex justify-between">
                  <div>
                    <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500">
                      Country
                    </div>
                    <div className="font-semibold text-xs mt-0.5">
                      {location?.country ?? "TBC"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500">
                      Round
                    </div>
                    <div className="font-bold text-xs mt-0.5 tabular-nums">
                      {race.round}
                    </div>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {selected && (
        <CircuitDetailsModal
          isOpen
          onClose={() => setSelected(null)}
          circuit={selected.detail}
          circuitImagePath={selected.circuitImagePath}
          flagPath={selected.flagPath}
        />
      )}
    </>
  );
}

"use client";

import { useState } from "react";
import Image from "next/image";
import { type Race } from "@/lib/api";
import { type CircuitDetail } from "@/lib/api";
import { getCountryFlagPath } from "@/lib/flags";
import { getCircuitImagePath } from "@/lib/circuit-images";
import CircuitDetailsModal from "./circuit-details-modal";

interface CircuitsGalleryProps {
  races: Race[];
  circuitDetails: CircuitDetail[];
}

export default function CircuitsGallery({ races, circuitDetails }: CircuitsGalleryProps) {
  const [selectedCircuit, setSelectedCircuit] = useState<{
    detail: CircuitDetail;
    circuitImagePath: string | null;
    flagPath: string | null;
  } | null>(null);

  // Color accents for gallery cards
  const accentColors = [
    "bg-secondary-container",
    "bg-primary-container",
    "bg-tertiary-container",
    "bg-secondary-container",
  ];

  const cardIcons = ["polyline", "conversion_path", "gesture", "directions_run", "route", "fork_right", "alt_route", "moving"];

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        {races.map((race, idx) => {
          const accent = accentColors[idx % accentColors.length];
          const icon = cardIcons[idx % cardIcons.length];
          const location = race.Circuit?.Location;
          const flagPath = getCountryFlagPath(location?.country);
          const circuitImagePath = getCircuitImagePath(
            location?.country,
            location?.locality,
            race.Circuit?.circuitName
          );

          // Find rich details if available
          const detail = circuitDetails.find((c) => c.round === Number(race.round));

          return (
            <div
              key={`${race.round}-${race.raceName}`}
              onClick={() => {
                if (detail) {
                  setSelectedCircuit({ detail, circuitImagePath, flagPath });
                }
              }}
              className={`group relative bg-surface-container-low overflow-hidden transition-all hover:scale-[1.02] duration-500 ${
                detail ? "cursor-pointer" : "cursor-default"
              }`}
            >
              <div className={`absolute top-0 left-0 w-full h-1 ${accent}`} />
              <div className="p-6 h-[400px] flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start mb-6">
                    <span className="text-[10px] font-black font-[family-name:var(--font-label)] text-outline tracking-widest">
                      {location?.locality?.toUpperCase() ?? `ROUND ${race.round}`}
                    </span>
                    <div className="w-8 h-5 bg-neutral-800 border border-neutral-700 flex items-center justify-center overflow-hidden">
                      {flagPath ? (
                        <Image
                          src={flagPath}
                          alt={location?.country ?? "Flag"}
                          width={32}
                          height={20}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="material-symbols-outlined text-xs text-neutral-600">
                          flag
                        </span>
                      )}
                    </div>
                  </div>
                  <h3
                    className="font-[family-name:var(--font-headline)] font-black text-3xl skew-heading uppercase italic tracking-tighter mb-4 group-hover:text-primary-container transition-colors line-clamp-2"
                    title={race.Circuit?.circuitName ?? ""}
                  >
                    {race.Circuit?.circuitName?.toUpperCase() ??
                      race.raceName.replace(" Grand Prix", "").toUpperCase()}
                  </h3>
                </div>

                <div className="relative flex-1 flex items-center justify-center h-40">
                  {circuitImagePath ? (
                    <div className="relative w-full h-full p-2 flex items-center justify-center group-hover:scale-110 transition-transform duration-700">
                      <Image
                        src={circuitImagePath}
                        alt={`${race.Circuit?.circuitName} layout`}
                        fill
                        className="object-contain opacity-50 group-hover:opacity-100 drop-shadow-[0_0_10px_rgba(255,255,255,0.1)] group-hover:drop-shadow-[0_0_20px_var(--primary)] transition-all duration-700 invert brightness-0 dark:invert-0 dark:brightness-100"
                      />
                    </div>
                  ) : (
                    <span className="material-symbols-outlined text-9xl text-white/5 absolute transition-all group-hover:scale-110 group-hover:text-primary-container/20">
                      {icon}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4 relative">
                  <div className="bg-surface-container-lowest p-3 relative z-10">
                    <p className="text-[8px] text-outline uppercase tracking-widest mb-1">
                      Country
                    </p>
                    <p className="text-sm font-[family-name:var(--font-headline)] font-bold">
                      {location?.country ?? "TBC"}
                    </p>
                  </div>
                  <div className="bg-surface-container-lowest p-3 relative z-10">
                    <p className="text-[8px] text-outline uppercase tracking-widest mb-1">
                      Round
                    </p>
                    <p className="text-sm font-[family-name:var(--font-headline)] font-bold">
                      {race.round}
                    </p>
                  </div>
                  {/* Hover indicator for modal */}
                  {detail && (
                    <div className="absolute inset-0 bg-primary-container/10 border border-primary-container/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-sm z-20">
                      <span className="text-primary-container font-[family-name:var(--font-label)] text-xs font-bold tracking-widest uppercase flex items-center gap-2">
                        View Track DNA
                        <span className="material-symbols-outlined text-sm">
                          arrow_forward
                        </span>
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className="absolute bottom-0 left-0 w-0 h-[2px] bg-primary-container group-hover:w-full transition-all duration-700" />
            </div>
          );
        })}
      </div>

      <CircuitDetailsModal
        isOpen={!!selectedCircuit}
        onClose={() => setSelectedCircuit(null)}
        circuit={selectedCircuit?.detail!}
        circuitImagePath={selectedCircuit?.circuitImagePath ?? null}
        flagPath={selectedCircuit?.flagPath ?? null}
      />
    </>
  );
}

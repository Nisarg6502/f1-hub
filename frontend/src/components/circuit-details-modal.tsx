"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { type CircuitDetail } from "@/lib/api";

interface CircuitDetailsModalProps {
  circuit: CircuitDetail;
  circuitImagePath: string | null;
  flagPath: string | null;
  isOpen: boolean;
  onClose: () => void;
}

export default function CircuitDetailsModal({
  circuit,
  circuitImagePath,
  flagPath,
  isOpen,
  onClose,
}: CircuitDetailsModalProps) {
  // Mount at the closed state for one frame so the open transition animates.
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      document.body.style.overflow = "hidden"; // Prevent background scrolling
      window.addEventListener("keydown", handleKeyDown);
    } else {
      document.body.style.overflow = "auto";
    }
    return () => {
      document.body.style.overflow = "auto";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  const info = circuit.track_information;
  const visible = isOpen && entered;

  // Only render the stats this circuit actually has data for. A zero here means
  // "not reported" rather than a real measurement, so it is treated as absent.
  const stats = [
    { label: "First Grand Prix", icon: "calendar_today", value: info?.first_grand_prix },
    { label: "Number of Laps", icon: "change_history", value: info?.number_of_laps },
    { label: "Corners", icon: "turn_right", value: info?.number_of_corners },
  ].filter((stat): stat is { label: string; icon: string; value: string | number } =>
    Boolean(stat.value)
  );

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-all duration-500 ${
          visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />

      {/* Modal Container */}
      <div
        className={`fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 md:p-12 pointer-events-none`}
      >
        <div
          className={`relative w-full max-w-6xl max-h-full bg-surface-container-low border border-outline-variant overflow-y-auto overflow-x-hidden pointer-events-auto transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] shadow-[0_0_100px_rgba(0,0,0,0.5)] ${
            visible
              ? "opacity-100 scale-100 translate-y-0"
              : "opacity-0 scale-95 translate-y-8"
          }`}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-6 right-6 z-20 w-10 h-10 bg-surface-container flex items-center justify-center rounded-full hover:bg-primary-container hover:text-on-primary-container transition-colors group"
          >
            <span className="material-symbols-outlined group-hover:rotate-90 transition-transform duration-300">
              close
            </span>
          </button>

          <div className="grid grid-cols-1 lg:grid-cols-2 min-h-[600px]">
            {/* Left Column: Visuals & Header */}
            <div className="relative p-8 lg:p-12 bg-gradient-to-br from-surface-container-low to-[#09090b] flex flex-col justify-between border-r border-outline-variant/30">
              {/* Background Glow */}
              <div className="absolute inset-0 bg-primary-container/5 blur-[100px] pointer-events-none" />

              <div className="relative z-10 mb-12">
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-12 h-8 bg-neutral-800 flex items-center justify-center overflow-hidden border border-outline-variant">
                    {flagPath ? (
                      <Image
                        src={flagPath}
                        alt={circuit.country}
                        width={48}
                        height={32}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="material-symbols-outlined text-neutral-500">
                        flag
                      </span>
                    )}
                  </div>
                  <span className="text-primary-container font-[family-name:var(--font-label)] font-bold tracking-[0.2em] uppercase text-xs">
                    Round {circuit.round} · {circuit.country}
                  </span>
                </div>
                
                <h2 className="text-4xl lg:text-6xl font-black font-[family-name:var(--font-headline)] skew-heading italic uppercase tracking-tighter leading-none mb-2">
                  {circuit.circuit_name}
                </h2>
                <p className="text-neutral-400 font-[family-name:var(--font-label)] tracking-widest text-sm uppercase">
                  {circuit.grand_prix}
                </p>
              </div>

              {/* Track Layout Visualization */}
              <div className="relative flex-1 flex items-center justify-center min-h-[300px] w-full">
                {circuitImagePath ? (
                  <Image
                    src={circuitImagePath}
                    alt={`${circuit.circuit_name} layout`}
                    fill
                    className="object-contain drop-shadow-[0_0_30px_rgba(255,255,255,0.1)] opacity-90 invert brightness-0 dark:invert-0 dark:brightness-100"
                  />
                ) : (
                  <span className="material-symbols-outlined text-[200px] text-neutral-800">
                    route
                  </span>
                )}
              </div>
            </div>

            {/* Right Column: Track Data */}
            <div className="p-8 lg:p-12 bg-surface-container-lowest flex flex-col justify-center">
              <h3 className="text-2xl font-black font-[family-name:var(--font-headline)] skew-heading italic uppercase tracking-tighter text-outline mb-8 border-b border-outline-variant pb-4">
                Track DNA
              </h3>

              <div className="grid grid-cols-2 gap-x-8 gap-y-10">
                {stats.map((stat) => (
                  <div key={stat.label} className="group">
                    <p className="text-[10px] text-outline font-[family-name:var(--font-label)] uppercase tracking-[0.2em] mb-2 flex items-center gap-2">
                      <span className="material-symbols-outlined text-[14px] text-primary-container">
                        {stat.icon}
                      </span>
                      {stat.label}
                    </p>
                    <p className="text-3xl font-black font-[family-name:var(--font-headline)] skew-heading italic text-on-surface">
                      {stat.value}
                    </p>
                  </div>
                ))}

                {info?.lap_record && (
                  <div className="col-span-2 group mt-4 bg-surface-container-low p-6 border-l-2 border-primary-container">
                    <p className="text-[10px] text-outline font-[family-name:var(--font-label)] uppercase tracking-[0.2em] mb-2 flex items-center gap-2">
                      <span className="material-symbols-outlined text-[14px] text-primary-container">
                        timer
                      </span>
                      Fastest Lap
                    </p>
                    <p className="text-2xl lg:text-3xl font-black font-[family-name:var(--font-headline)] skew-heading italic text-on-surface">
                      {info.lap_record}
                    </p>
                  </div>
                )}

                {stats.length === 0 && !info?.lap_record && (
                  <p className="col-span-2 text-sm text-neutral-500">
                    No track data recorded for this circuit yet.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

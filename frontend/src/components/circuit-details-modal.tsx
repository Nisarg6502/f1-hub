"use client";

import { useState, useEffect } from "react";
import { type CircuitDetail } from "@/lib/api";
import TrackMap from "./track-map";
import FlagImg from "./flag-img";

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
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      document.body.style.overflow = "hidden";
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
    { label: "Laps", value: info?.number_of_laps },
    { label: "Corners", value: info?.number_of_corners },
    { label: "First GP", value: info?.first_grand_prix },
  ].filter(
    (s): s is { label: string; value: string | number } => Boolean(s.value)
  );

  return (
    <div
      onClick={onClose}
      className={`fixed inset-0 z-[80] flex items-center justify-center p-5 md:p-10 bg-[rgba(6,5,4,0.6)] backdrop-blur-[6px] transition-opacity duration-200 ${
        visible ? "opacity-100" : "opacity-0 pointer-events-none"
      }`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative w-[560px] max-w-full max-h-full overflow-y-auto rounded-[24px] apex-glass-strong apex-sheen transition-all duration-300 ease-[cubic-bezier(0.2,0.9,0.2,1)] ${
          visible
            ? "opacity-100 scale-100 translate-y-0"
            : "opacity-0 scale-95 translate-y-6"
        }`}
      >
        <div
          className="h-[5px]"
          style={{ background: "linear-gradient(90deg,#FFAE6A,#FF5A1F)" }}
        />
        <div className="relative p-[30px]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 mb-2">
                {flagPath && (
                  <span className="w-[26px] h-[18px] rounded overflow-hidden flex-none">
                    <FlagImg
                      src={flagPath}
                      alt={circuit.country}
                      width={26}
                      height={18}
                      className="object-cover w-full h-full"
                    />
                  </span>
                )}
                <span className="font-bold text-[10px] tracking-[0.12em] uppercase text-[#FF7A3D]">
                  Round {circuit.round} · {circuit.country}
                </span>
              </div>
              <div className="font-[family-name:var(--font-headline)] font-extrabold text-2xl md:text-[30px] tracking-[-0.5px] leading-[1.02]">
                {circuit.circuit_name}
              </div>
              <div className="font-semibold text-xs text-warm-400 mt-1">
                {circuit.grand_prix}
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-[34px] h-[34px] rounded-[10px] bg-[rgba(245,235,222,0.08)] flex items-center justify-center text-warm-200 text-lg hover:bg-[rgba(245,235,222,0.14)] transition-[background-color,transform] duration-150 active:scale-90 flex-none"
            >
              ×
            </button>
          </div>

          <TrackMap
            src={circuitImagePath}
            alt={`${circuit.circuit_name} layout`}
            containerClassName="my-[22px] h-[150px] rounded-[14px]"
            imgClassName="object-contain p-4"
            labelClassName="font-semibold text-[10px] tracking-[0.16em] text-warm-600"
            sizes="(max-width: 768px) 90vw, 520px"
          />

          {stats.length > 0 || info?.lap_record ? (
            <div className="grid grid-cols-3 gap-3">
              {stats.map((s) => (
                <div
                  key={s.label}
                  className="bg-[rgba(245,235,222,0.05)] rounded-xl px-3.5 py-3.5"
                >
                  <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500">
                    {s.label}
                  </div>
                  <div className="font-extrabold text-xl tabular-nums mt-1">
                    {s.value}
                  </div>
                </div>
              ))}
              {info?.lap_record && (
                <div className="bg-[rgba(245,235,222,0.05)] rounded-xl px-3.5 py-3.5">
                  <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500">
                    Lap record
                  </div>
                  <div className="font-extrabold text-[15px] tabular-nums mt-1.5 text-[#FFAE6A]">
                    {info.lap_record}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="font-medium text-sm text-warm-400">
              No track data recorded for this circuit yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

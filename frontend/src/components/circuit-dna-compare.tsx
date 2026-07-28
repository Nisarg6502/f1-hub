"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronsUpDown } from "lucide-react";
import { type Race, type CircuitDetail } from "@/lib/api";
import { getCountryFlagPath } from "@/lib/flags";
import { getCircuitImagePath } from "@/lib/circuit-images";
import FlagImg from "./flag-img";
import CircuitCompareModal from "./circuit-compare-modal";

// The real cross-track "Circuit DNA" comparison (CP34) — the stat card this
// replaces borrowed the name but only ever summarized the current season.
// This builds the actual thing: pick two circuits with cached
// `circuit_details` and compare their real numbers (corners, laps, lap
// record) plus whatever `circuit_history` has for each.
export interface CircuitOption {
  round: number;
  label: string;
  country: string;
  circuitImagePath: string | null;
  flagPath: string | null;
  detail: CircuitDetail;
}

interface CircuitDnaCompareProps {
  races: Race[];
  circuitDetails: CircuitDetail[];
}

function buildOptions(
  races: Race[],
  circuitDetails: CircuitDetail[]
): CircuitOption[] {
  return races
    .map((race): CircuitOption | null => {
      const detail = circuitDetails.find((c) => c.round === Number(race.round));
      if (!detail) return null;
      const location = race.Circuit?.Location;
      return {
        round: Number(race.round),
        label: race.Circuit?.circuitName ?? race.raceName,
        country: location?.country ?? detail.country ?? "—",
        circuitImagePath: getCircuitImagePath(
          location?.country,
          location?.locality,
          race.Circuit?.circuitName
        ),
        flagPath: getCountryFlagPath(location?.country),
        detail,
      };
    })
    .filter((option): option is CircuitOption => Boolean(option));
}

interface CircuitSelectProps {
  options: CircuitOption[];
  selectedRound: number | null;
  excludeRound: number | null;
  placeholder: string;
  onSelect: (round: number) => void;
}

function CircuitSelect({
  options,
  selectedRound,
  excludeRound,
  placeholder,
  onSelect,
}: CircuitSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const selected = options.find((o) => o.round === selectedRound) ?? null;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center justify-between gap-2 w-full rounded-[10px] bg-[rgba(245,235,222,0.06)] border border-white/10 px-3.5 py-2.5 text-xs hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-[0.98]"
      >
        <span className="flex items-center gap-2 min-w-0">
          {selected?.flagPath && (
            <span className="w-[20px] h-[14px] rounded overflow-hidden flex-none bg-[rgba(245,235,222,0.08)]">
              <FlagImg
                src={selected.flagPath}
                alt=""
                width={20}
                height={14}
                className="object-cover w-full h-full"
              />
            </span>
          )}
          <span
            className={`truncate font-semibold ${selected ? "" : "text-warm-500"}`}
          >
            {selected ? selected.label : placeholder}
          </span>
        </span>
        <ChevronsUpDown className="w-3.5 h-3.5 text-warm-400 flex-none" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            transition={{ duration: reduce ? 0.1 : 0.16, ease: [0.23, 1, 0.32, 1] }}
            style={{ transformOrigin: "top" }}
            role="listbox"
            className="absolute top-full left-0 mt-1.5 w-full min-w-[220px] rounded-xl bg-[rgba(26,22,19,0.98)] border border-white/10 shadow-2xl z-50 max-h-64 overflow-y-auto p-1"
          >
            {options.map((option) => {
              const isSelected = option.round === selectedRound;
              const isExcluded = option.round === excludeRound;
              return (
                <div
                  key={option.round}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={isExcluded}
                  onClick={() => {
                    if (isExcluded) return;
                    onSelect(option.round);
                    setOpen(false);
                  }}
                  className={`flex items-center px-3 py-2 rounded-lg transition-colors ${
                    isExcluded
                      ? "opacity-35 cursor-not-allowed"
                      : `cursor-pointer hover:bg-white/[0.05] ${
                          isSelected ? "text-[#FFAE6A]" : "text-warm-300"
                        }`
                  }`}
                >
                  <div className="w-4 h-4 rounded border border-warm-600 mr-2.5 flex items-center justify-center flex-none">
                    {isSelected && <Check className="w-3 h-3" />}
                  </div>
                  {option.flagPath && (
                    <span className="w-[18px] h-[13px] rounded overflow-hidden flex-none mr-2 bg-[rgba(245,235,222,0.08)]">
                      <FlagImg
                        src={option.flagPath}
                        alt=""
                        width={18}
                        height={13}
                        className="object-cover w-full h-full"
                      />
                    </span>
                  )}
                  <span className="font-semibold truncate text-xs">
                    {option.label}
                  </span>
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function CircuitDnaCompare({
  races,
  circuitDetails,
}: CircuitDnaCompareProps) {
  const options = buildOptions(races, circuitDetails);
  const [roundA, setRoundA] = useState<number | null>(null);
  const [roundB, setRoundB] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);

  const circuitA = options.find((o) => o.round === roundA) ?? null;
  const circuitB = options.find((o) => o.round === roundB) ?? null;
  const canCompare = Boolean(circuitA && circuitB && roundA !== roundB);

  return (
    <div className="relative">
      <div className="font-[family-name:var(--font-headline)] font-bold text-base mb-1">
        Circuit DNA
      </div>
      <p className="font-medium text-[11px] leading-snug text-warm-500 mb-4">
        Compare two tracks by corners, laps, lap record and history
      </p>

      {options.length < 2 ? (
        <p className="font-medium text-xs text-warm-400 py-6">
          Not enough circuit data cached yet to compare tracks.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          <CircuitSelect
            options={options}
            selectedRound={roundA}
            excludeRound={roundB}
            placeholder="Select circuit A…"
            onSelect={setRoundA}
          />
          <CircuitSelect
            options={options}
            selectedRound={roundB}
            excludeRound={roundA}
            placeholder="Select circuit B…"
            onSelect={setRoundB}
          />
          <button
            onClick={() => setShowModal(true)}
            disabled={!canCompare}
            className="font-bold text-xs tracking-[0.08em] uppercase text-[#1a1210] px-5 py-2.5 rounded-[12px] shadow-[0_6px_20px_rgba(255,90,31,0.35)] disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed transition-[box-shadow,transform] duration-150 active:scale-95 mt-1"
            style={{ background: "linear-gradient(90deg,#FFAE6A,#FF5A1F)" }}
          >
            Compare tracks
          </button>
        </div>
      )}

      <AnimatePresence>
        {showModal && circuitA && circuitB && (
          <CircuitCompareModal
            circuitA={circuitA}
            circuitB={circuitB}
            onClose={() => setShowModal(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

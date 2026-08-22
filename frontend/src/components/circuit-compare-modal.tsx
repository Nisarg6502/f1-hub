"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { getCircuitHistory, type CircuitHistory } from "@/lib/api";
import { useModalDialog } from "@/lib/use-modal-dialog";
import type { CircuitOption } from "./circuit-dna-compare";
import TrackMap from "./track-map";
import FlagImg from "./flag-img";

interface CircuitCompareModalProps {
  circuitA: CircuitOption;
  circuitB: CircuitOption;
  onClose: () => void;
}

// Mirrors circuit-details-modal.tsx's gap formatting so "closest finish"
// reads identically wherever it appears.
function formatGapSeconds(gapSeconds: number): string {
  if (gapSeconds < 60) return `${gapSeconds.toFixed(3)}s`;
  const minutes = Math.floor(gapSeconds / 60);
  const seconds = gapSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

interface Row {
  label: string;
  a: string | number;
  b: string | number;
}

function buildRows(
  circuitA: CircuitOption,
  circuitB: CircuitOption,
  historyA: CircuitHistory | null,
  historyB: CircuitHistory | null
): Row[] {
  const infoA = circuitA.detail.track_information;
  const infoB = circuitB.detail.track_information;
  const rows: (Row | null)[] = [
    { label: "Country", a: circuitA.country, b: circuitB.country },
    {
      label: "Total laps",
      a: infoA?.number_of_laps ?? "—",
      b: infoB?.number_of_laps ?? "—",
    },
    {
      label: "Corners",
      a: infoA?.number_of_corners ?? "—",
      b: infoB?.number_of_corners ?? "—",
    },
    infoA?.lap_record || infoB?.lap_record
      ? {
          label: "Lap record",
          a: infoA?.lap_record ?? "—",
          b: infoB?.lap_record ?? "—",
        }
      : null,
    historyA?.first_year || historyB?.first_year
      ? {
          label: "First raced",
          a: historyA?.first_year ?? "—",
          b: historyB?.first_year ?? "—",
        }
      : null,
    historyA?.most_wins || historyB?.most_wins
      ? {
          label: "Most wins",
          a: historyA?.most_wins
            ? `${historyA.most_wins.driver} (${historyA.most_wins.wins})`
            : "—",
          b: historyB?.most_wins
            ? `${historyB.most_wins.driver} (${historyB.most_wins.wins})`
            : "—",
        }
      : null,
    historyA?.closest_finish || historyB?.closest_finish
      ? {
          label: "Closest finish",
          a: historyA?.closest_finish
            ? `${formatGapSeconds(historyA.closest_finish.gap_seconds)} · ${historyA.closest_finish.season}`
            : "—",
          b: historyB?.closest_finish
            ? `${formatGapSeconds(historyB.closest_finish.gap_seconds)} · ${historyB.closest_finish.season}`
            : "—",
        }
      : null,
  ];
  return rows.filter((r): r is Row => Boolean(r));
}

function CircuitHalf({ circuit }: { circuit: CircuitOption }) {
  return (
    <div
      className="relative h-[150px] overflow-hidden"
      style={{
        background: "linear-gradient(180deg, rgba(255,138,61,0.16), transparent)",
      }}
    >
      <TrackMap
        src={circuit.circuitImagePath}
        alt={`${circuit.label} layout`}
        containerClassName="absolute inset-0"
        imgClassName="object-contain p-6 opacity-90"
        sizes="380px"
      />
      <div
        className="absolute top-0 left-0 right-0 h-[4px]"
        style={{ background: "#FF8A3D", boxShadow: "0 0 16px rgba(255,138,61,0.5)" }}
      />
      <div className="absolute bottom-3 left-4 right-4">
        <div className="flex items-center gap-2 mb-1">
          {circuit.flagPath && (
            <span className="w-[22px] h-[15px] rounded overflow-hidden flex-none">
              <FlagImg
                src={circuit.flagPath}
                alt=""
                width={22}
                height={15}
                className="object-cover w-full h-full"
              />
            </span>
          )}
          <span className="font-bold text-[9px] tracking-[0.12em] uppercase text-flame">
            {circuit.country}
          </span>
        </div>
        <div className="font-[family-name:var(--font-headline)] font-extrabold text-lg leading-none">
          {circuit.label}
        </div>
      </div>
    </div>
  );
}

export default function CircuitCompareModal({
  circuitA,
  circuitB,
  onClose,
}: CircuitCompareModalProps) {
  const reduce = useReducedMotion();
  const [historyA, setHistoryA] = useState<CircuitHistory | null>(null);
  const [historyB, setHistoryB] = useState<CircuitHistory | null>(null);
  const [loading, setLoading] = useState(true);

  // Each circuit's cross-season history is its own fetch (see
  // circuit-details-modal.tsx, which does the same per-circuit lookup) — the
  // round-scoped stats used above come straight from the `detail` prop.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getCircuitHistory(circuitA.detail.circuit_name),
      getCircuitHistory(circuitB.detail.circuit_name),
    ]).then(([a, b]) => {
      if (cancelled) return;
      setHistoryA(a);
      setHistoryB(b);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [circuitA.detail.circuit_name, circuitB.detail.circuit_name]);

  // See `use-modal-dialog.ts`: Escape + scroll lock as before, plus the dialog
  // semantics, initial focus and Tab containment this modal never had.
  const dialogRef = useModalDialog<HTMLDivElement>({ onClose });

  const rows = buildRows(circuitA, circuitB, historyA, historyB);

  return createPortal(
    <motion.div
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[80] flex items-center justify-center p-5 md:p-10 bg-surface-container-lowest/65 backdrop-blur-[8px]"
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${circuitA.label} compared with ${circuitB.label}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 24 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 12 }}
        transition={
          reduce ? { duration: 0.15 } : { type: "spring", stiffness: 320, damping: 30 }
        }
        className="relative w-[680px] max-w-full max-h-full overflow-y-auto rounded-panel apex-glass-strong apex-sheen"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-5 right-5 z-10 w-[34px] h-[34px] rounded-control bg-surface-container-low/50 flex items-center justify-center text-warm-200 text-lg hover:bg-surface-container-low/70 transition-[background-color,transform] duration-150 active:scale-90"
        >
          ×
        </button>

        <div className="grid grid-cols-2">
          <CircuitHalf circuit={circuitA} />
          <CircuitHalf circuit={circuitB} />
        </div>

        <div className="p-[30px] pt-6">
          <div className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500 mb-3">
            Track DNA
          </div>

          {loading ? (
            <div className="space-y-2.5 animate-pulse">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-[46px] rounded-xl bg-veil/5" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-warm-400 font-medium">
              No comparable track data cached for these circuits yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_1.4fr_1.4fr] gap-2 px-3.5">
                <span />
                <span className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500 truncate">
                  {circuitA.label}
                </span>
                <span className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500 truncate text-right">
                  {circuitB.label}
                </span>
              </div>
              {rows.map((row) => (
                <div
                  key={row.label}
                  className="grid grid-cols-[1fr_1.4fr_1.4fr] gap-2 items-center bg-veil/5 rounded-xl px-3.5 py-3"
                >
                  <span className="font-semibold text-[10px] tracking-[0.06em] uppercase text-warm-400">
                    {row.label}
                  </span>
                  <span className="font-bold text-xs md:text-sm tabular-nums truncate text-primary">
                    {row.a}
                  </span>
                  <span className="font-bold text-xs md:text-sm tabular-nums truncate text-right text-primary">
                    {row.b}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
}

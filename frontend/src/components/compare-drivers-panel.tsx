"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronsUpDown } from "lucide-react";
import type { DriverStanding } from "@/lib/api";
import { getTeamColor } from "@/lib/team-colors";
import DriverCompareModal from "./driver-compare-modal";

interface CompareDriversPanelProps {
  drivers: DriverStanding[];
  seasonYear: number;
}

function driverName(d: DriverStanding): string {
  return `${d.Driver.givenName ?? ""} ${d.Driver.familyName ?? ""}`.trim();
}

interface DriverSelectProps {
  drivers: DriverStanding[];
  selectedId: string;
  excludeId: string;
  placeholder: string;
  onSelect: (driverId: string) => void;
}

function DriverSelect({ drivers, selectedId, excludeId, placeholder, onSelect }: DriverSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const selected = drivers.find((d) => d.Driver.driverId === selectedId) ?? null;
  const selectedColor = selected ? getTeamColor(selected.Constructors?.[0]?.name ?? "—") : null;

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
    <div className="relative flex-1 min-w-0" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center justify-between gap-2 w-full rounded-control bg-veil/6 border border-white/10 px-4 py-2.5 text-xs hover:border-flame-bright/50 transition-[border-color,transform] duration-150 active:scale-[0.98]"
      >
        <span className="flex items-center gap-2 min-w-0">
          {selected && selectedColor && (
            <span
              className="w-1 h-3.5 rounded-full flex-none"
              style={{ background: selectedColor.hex }}
            />
          )}
          <span className={`truncate font-semibold ${selected ? "" : "text-warm-500"}`}>
            {selected ? driverName(selected) : placeholder}
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
            className="absolute top-full left-0 mt-1.5 w-full min-w-[220px] rounded-xl bg-surface-container/98 border border-white/10 shadow-2xl z-50 max-h-64 overflow-y-auto p-1"
          >
            {drivers.map((driver) => {
              const driverId = driver.Driver.driverId ?? "";
              const isSelected = driverId === selectedId;
              const isExcluded = driverId === excludeId;
              const color = getTeamColor(driver.Constructors?.[0]?.name ?? "—");
              return (
                <div
                  key={driverId}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={isExcluded}
                  onClick={() => {
                    if (isExcluded) return;
                    onSelect(driverId);
                    setOpen(false);
                  }}
                  className={`flex items-center px-3 py-2 rounded-lg transition-colors ${
                    isExcluded
                      ? "opacity-35 cursor-not-allowed"
                      : `cursor-pointer hover:bg-white/[0.05] ${
                          isSelected ? "text-primary" : "text-warm-300"
                        }`
                  }`}
                >
                  <div className="w-4 h-4 rounded border border-warm-600 mr-3 flex items-center justify-center flex-none">
                    {isSelected && <Check className="w-3 h-3" />}
                  </div>
                  <div
                    className="w-1 h-4 mr-2.5 rounded-full flex-none"
                    style={{ backgroundColor: color.hex }}
                  />
                  <span className="font-semibold truncate">{driverName(driver)}</span>
                  <span className="ml-2 text-[10px] text-warm-500 truncate">
                    {driver.Constructors?.[0]?.name ?? ""}
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

export default function CompareDriversPanel({ drivers, seasonYear }: CompareDriversPanelProps) {
  const [driverAId, setDriverAId] = useState("");
  const [driverBId, setDriverBId] = useState("");
  const [showModal, setShowModal] = useState(false);

  if (drivers.length < 2) return null;

  const driverA = drivers.find((d) => d.Driver.driverId === driverAId) ?? null;
  const driverB = drivers.find((d) => d.Driver.driverId === driverBId) ?? null;
  const canCompare = Boolean(driverA && driverB && driverAId !== driverBId);

  return (
    <div className="apex-glass-soft rounded-2xl px-5 py-4 mb-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
      <span className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500 shrink-0">
        Compare drivers
      </span>
      <DriverSelect
        drivers={drivers}
        selectedId={driverAId}
        excludeId={driverBId}
        placeholder="Select driver A…"
        onSelect={setDriverAId}
      />
      <DriverSelect
        drivers={drivers}
        selectedId={driverBId}
        excludeId={driverAId}
        placeholder="Select driver B…"
        onSelect={setDriverBId}
      />
      <button
        onClick={() => setShowModal(true)}
        disabled={!canCompare}
        className="font-bold text-xs tracking-[0.08em] uppercase text-[#1a1210] px-5 py-2.5 rounded-control shadow-[0_6px_20px_rgb(var(--rgb-primary-container)_/_0.35)] disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed transition-[box-shadow,transform] duration-150 active:scale-95 shrink-0"
        style={{ background: "linear-gradient(90deg,var(--color-primary),var(--color-primary-container))" }}
      >
        Compare
      </button>

      <AnimatePresence>
        {showModal && driverA && driverB && (
          <DriverCompareModal
            driverA={driverA}
            driverB={driverB}
            seasonYear={seasonYear}
            onClose={() => setShowModal(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

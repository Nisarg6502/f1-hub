"use client";

import { useState } from "react";
import { AnimatePresence } from "motion/react";
import type { DriverStanding } from "@/lib/api";
import DriverCompareModal from "./driver-compare-modal";

interface CompareDriversPanelProps {
  drivers: DriverStanding[];
  seasonYear: number;
}

function driverLabel(d: DriverStanding): string {
  const given = d.Driver.givenName ?? "";
  const family = d.Driver.familyName ?? "";
  const team = d.Constructors?.[0]?.name ?? "";
  return `${given} ${family}${team ? ` · ${team}` : ""}`;
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
      <select
        value={driverAId}
        onChange={(e) => setDriverAId(e.target.value)}
        className="flex-1 min-w-0 bg-[rgba(245,235,222,0.06)] border border-white/10 rounded-lg px-3 py-2 text-xs font-medium text-on-background outline-none"
      >
        <option value="">Select driver A…</option>
        {drivers.map((d) => (
          <option key={d.Driver.driverId} value={d.Driver.driverId}>
            {driverLabel(d)}
          </option>
        ))}
      </select>
      <select
        value={driverBId}
        onChange={(e) => setDriverBId(e.target.value)}
        className="flex-1 min-w-0 bg-[rgba(245,235,222,0.06)] border border-white/10 rounded-lg px-3 py-2 text-xs font-medium text-on-background outline-none"
      >
        <option value="">Select driver B…</option>
        {drivers.map((d) => (
          <option key={d.Driver.driverId} value={d.Driver.driverId}>
            {driverLabel(d)}
          </option>
        ))}
      </select>
      <button
        onClick={() => setShowModal(true)}
        disabled={!canCompare}
        className="font-bold text-xs tracking-[0.08em] uppercase text-[#1a1210] px-5 py-2.5 rounded-[12px] shadow-[0_6px_20px_rgba(255,90,31,0.35)] disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed transition-[box-shadow,transform] duration-150 active:scale-95 shrink-0"
        style={{ background: "linear-gradient(90deg,#FFAE6A,#FF5A1F)" }}
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

"use client";

import { motion, useReducedMotion } from "motion/react";

const RING = 276; // 2πr for r=44

/**
 * A progress ring whose coloured arc "draws itself in" (line-drawing) the first
 * time it enters view, with the centre label underneath. Used on the home stat
 * card. Falls back to the static filled arc under reduced-motion.
 */
export function AnimatedRing({
  center,
  label,
  offset,
  color,
}: {
  center: string;
  label: string;
  /** final strokeDashoffset — smaller means more of the ring is filled */
  offset: number;
  color: string;
}) {
  const reduce = useReducedMotion();
  return (
    <div className="relative text-center">
      <svg width="108" height="108" viewBox="0 0 108 108">
        <circle
          cx="54"
          cy="54"
          r="44"
          fill="none"
          stroke="rgba(245,235,222,0.07)"
          strokeWidth="5"
        />
        <motion.circle
          cx="54"
          cy="54"
          r="44"
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          transform="rotate(-90 54 54)"
          strokeDasharray={RING}
          initial={reduce ? { strokeDashoffset: offset } : { strokeDashoffset: RING }}
          whileInView={{ strokeDashoffset: offset }}
          viewport={{ once: true, margin: "0px 0px -40px 0px" }}
          transition={{ duration: 1.1, ease: [0.23, 1, 0.32, 1], delay: 0.15 }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-extrabold text-2xl tabular-nums">{center}</span>
        <span className="font-semibold text-[9px] tracking-[0.12em] uppercase text-warm-500">
          {label}
        </span>
      </div>
    </div>
  );
}

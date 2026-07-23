"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";
import type { DriverStanding, DriverBio } from "@/lib/api";
import { getDriverBio } from "@/lib/api";
import FlagImg from "./flag-img";

interface DriverModalProps {
  driver: DriverStanding;
  imgPath: string | null;
  flagSrc: string | null;
  color: { hex: string; glow: string };
  onClose: () => void;
}

function ageFromDob(dob?: string | null): number | null {
  if (!dob) return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;
  const diffMs = Date.now() - born.getTime();
  return Math.floor(diffMs / (365.25 * 24 * 3600 * 1000));
}

export default function DriverModal({
  driver,
  imgPath,
  flagSrc,
  color,
  onClose,
}: DriverModalProps) {
  const reduce = useReducedMotion();
  const driverId = driver.Driver.driverId;
  const [bio, setBio] = useState<DriverBio | null>(null);
  const [bioLoading, setBioLoading] = useState(Boolean(driverId));

  const given = driver.Driver.givenName ?? "";
  const family = driver.Driver.familyName ?? "";
  const team = driver.Constructors?.[0]?.name ?? "—";
  const photoLayoutId =
    !reduce && driverId ? `driver-photo-${driverId}` : undefined;

  useEffect(() => {
    // The parent keys this component by driverId (see drivers-grid.tsx), so
    // it remounts fresh per driver — this effect only ever runs once, with
    // bioLoading already true from its initializer above.
    if (!driverId) return;
    let cancelled = false;
    getDriverBio(driverId)
      .then((res) => {
        if (!cancelled) setBio(res);
      })
      .catch(() => {
        if (!cancelled) setBio(null);
      })
      .finally(() => {
        if (!cancelled) setBioLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [driverId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "auto";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const age = ageFromDob(bio?.dateOfBirth);

  const careerStats = [
    { l: "Wins", v: bio?.wins ?? 0 },
    { l: "Podiums", v: bio?.podiums ?? 0 },
    { l: "Poles", v: bio?.poles ?? 0 },
    { l: "Titles", v: bio?.championships ?? 0 },
  ];

  return (
    <motion.div
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[80] flex items-center justify-center p-5 md:p-10 bg-[rgba(6,5,4,0.65)] backdrop-blur-[8px]"
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 24 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 12 }}
        transition={
          reduce
            ? { duration: 0.15 }
            : { type: "spring", stiffness: 320, damping: 30 }
        }
        className="relative w-[640px] max-w-full max-h-full overflow-y-auto rounded-[24px] apex-glass-strong apex-sheen"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-5 right-5 z-10 w-[34px] h-[34px] rounded-[10px] bg-[rgba(16,14,11,0.5)] flex items-center justify-center text-warm-200 text-lg hover:bg-[rgba(16,14,11,0.7)] transition-[background-color,transform] duration-150 active:scale-90"
        >
          ×
        </button>

        <div
          className="relative h-[300px] overflow-hidden"
          style={{
            background: `linear-gradient(180deg, ${color.hex}26, transparent)`,
          }}
        >
          {imgPath && (
            <motion.div layoutId={photoLayoutId} className="absolute inset-0">
              <Image
                src={imgPath}
                alt={`${given} ${family}`}
                fill
                sizes="640px"
                className="object-contain object-bottom drop-shadow-[0_20px_40px_rgba(0,0,0,0.7)]"
                priority
              />
            </motion.div>
          )}
          <div
            className="absolute top-0 left-0 right-0 h-[4px]"
            style={{ background: color.hex, boxShadow: `0 0 16px ${color.glow}` }}
          />
        </div>

        <div className="p-[30px] pt-6">
          <div className="flex items-center gap-2.5 mb-2">
            {flagSrc && (
              <span className="w-[26px] h-[18px] rounded overflow-hidden flex-none">
                <FlagImg
                  src={flagSrc}
                  alt={driver.Driver.nationality ?? ""}
                  width={26}
                  height={18}
                  className="object-cover w-full h-full"
                />
              </span>
            )}
            <span className="font-bold text-[10px] tracking-[0.12em] uppercase text-[#FF7A3D]">
              {team}
            </span>
          </div>
          <div className="font-[family-name:var(--font-headline)] font-extrabold text-3xl md:text-[38px] tracking-[-0.5px] leading-[1.02]">
            {given} {family}
          </div>

          {/* Current-season stats — already known, no fetch needed. */}
          <div className="grid grid-cols-3 gap-3 mt-5">
            {[
              { l: "Position", v: `P${driver.position}` },
              { l: "Points", v: driver.points },
              { l: "Season wins", v: driver.wins },
            ].map((s) => (
              <div
                key={s.l}
                className="bg-[rgba(245,235,222,0.05)] rounded-xl px-3.5 py-3.5"
              >
                <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500">
                  {s.l}
                </div>
                <div className="font-extrabold text-xl tabular-nums mt-1">
                  {s.v}
                </div>
              </div>
            ))}
          </div>

          {/* Bio + career totals — fetched lazily on open. */}
          <div className="mt-6">
            <div className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500 mb-3">
              Career
            </div>
            {bioLoading ? (
              <div className="grid grid-cols-4 gap-3 animate-pulse">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-[66px] rounded-xl bg-[rgba(245,235,222,0.05)]"
                  />
                ))}
              </div>
            ) : bio ? (
              <>
                <div className="grid grid-cols-4 gap-3">
                  {careerStats.map((s) => (
                    <div
                      key={s.l}
                      className="bg-[rgba(245,235,222,0.05)] rounded-xl px-3.5 py-3.5 text-center"
                    >
                      <div className="font-extrabold text-xl tabular-nums text-[#FFAE6A]">
                        {s.v}
                      </div>
                      <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500 mt-1">
                        {s.l}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-4 text-xs text-warm-400 font-medium">
                  {bio.nationality && <span>{bio.nationality}</span>}
                  {bio.dateOfBirth && (
                    <span>
                      Born {bio.dateOfBirth}
                      {age !== null ? ` · ${age} years old` : ""}
                    </span>
                  )}
                  {bio.wikiUrl && (
                    <a
                      href={bio.wikiUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-bold text-[#FF7A3D] hover:text-[#FFAE6A] transition-colors"
                    >
                      Wikipedia →
                    </a>
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-warm-400 font-medium">
                Career stats unavailable right now.
              </p>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

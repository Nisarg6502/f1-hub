"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Search } from "lucide-react";
import {
  getActiveSeasonYear,
  getCircuitDetails,
  getConstructorStandings,
  getDriverStandings,
  getSeasonRaces,
  type CircuitDetail,
  type ConstructorStanding,
  type DriverStanding,
  type Race,
} from "@/lib/api";
import { getDriverImagePath, hasDriverImage } from "@/lib/driver-images";
import { getCountryFlagPath, getFlagPath } from "@/lib/flags";
import { getCircuitImagePath } from "@/lib/circuit-images";
import { getTeamColor } from "@/lib/team-colors";
import DriverModal from "./driver-modal";
import CircuitDetailsModal from "./circuit-details-modal";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

interface DriverResult {
  kind: "driver";
  key: string;
  label: string;
  sublabel: string;
  driver: DriverStanding;
}

interface CircuitResult {
  kind: "circuit";
  key: string;
  label: string;
  sublabel: string;
  detail: CircuitDetail;
  circuitImagePath: string | null;
  flagPath: string | null;
}

interface TeamResult {
  kind: "team";
  key: string;
  label: string;
  sublabel: string;
}

type SearchResult = DriverResult | CircuitResult | TeamResult;

function driverName(d: DriverStanding): string {
  return `${d.Driver.givenName ?? ""} ${d.Driver.familyName ?? ""}`.trim();
}

export default function GlobalSearch() {
  const router = useRouter();
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [drivers, setDrivers] = useState<DriverStanding[]>([]);
  const [constructors, setConstructors] = useState<ConstructorStanding[]>([]);
  const [races, setRaces] = useState<Race[]>([]);
  const [circuitDetails, setCircuitDetails] = useState<CircuitDetail[]>([]);

  const [selectedDriver, setSelectedDriver] = useState<DriverResult | null>(null);
  const [selectedCircuit, setSelectedCircuit] = useState<CircuitResult | null>(null);

  // Fetch once — the root layout persists across client-side navigations, so
  // this only runs a single time per page load, reusing the same season data
  // every other page already fetches (driver/constructor standings, races,
  // circuit details) rather than standing up a new backend endpoint.
  useEffect(() => {
    let cancelled = false;
    const year = getActiveSeasonYear();

    Promise.allSettled([
      getDriverStandings(year),
      getConstructorStandings(year),
      getSeasonRaces(year),
      getCircuitDetails(year),
    ]).then(([ds, cs, rc, cd]) => {
      if (cancelled) return;
      setDrivers(ds.status === "fulfilled" ? ds.value.driver_standings ?? [] : []);
      setConstructors(cs.status === "fulfilled" ? cs.value.constructor_standings ?? [] : []);
      setRaces(rc.status === "fulfilled" ? rc.value.races ?? [] : []);
      setCircuitDetails(cd.status === "fulfilled" ? cd.value : []);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];

    const driverResults: DriverResult[] = drivers
      .filter((d) => {
        const name = driverName(d).toLowerCase();
        const team = (d.Constructors?.[0]?.name ?? "").toLowerCase();
        return name.includes(q) || team.includes(q);
      })
      .map((d) => ({
        kind: "driver" as const,
        key: `driver-${d.Driver.driverId ?? driverName(d)}`,
        label: driverName(d),
        sublabel: d.Constructors?.[0]?.name ?? "—",
        driver: d,
      }));

    const teamResults: TeamResult[] = constructors
      .filter((c) => (c.Constructor.name ?? "").toLowerCase().includes(q))
      .map((c) => ({
        kind: "team" as const,
        key: `team-${c.Constructor.constructorId ?? c.Constructor.name}`,
        label: c.Constructor.name ?? "—",
        sublabel: "Constructor",
      }));

    const circuitResults: CircuitResult[] = races
      .filter((race) => {
        const name = (race.Circuit?.circuitName ?? race.raceName).toLowerCase();
        const locality = (race.Circuit?.Location?.locality ?? "").toLowerCase();
        const country = (race.Circuit?.Location?.country ?? "").toLowerCase();
        return name.includes(q) || locality.includes(q) || country.includes(q);
      })
      .map((race) => {
        const detail = circuitDetails.find((c) => c.round === Number(race.round));
        if (!detail) return null;
        const location = race.Circuit?.Location;
        return {
          kind: "circuit" as const,
          key: `circuit-${race.round}`,
          label: race.Circuit?.circuitName ?? race.raceName,
          sublabel: location?.country ?? "",
          detail,
          circuitImagePath: getCircuitImagePath(
            location?.country,
            location?.locality,
            race.Circuit?.circuitName
          ),
          flagPath: getCountryFlagPath(location?.country),
        };
      })
      .filter((r): r is CircuitResult => r !== null);

    return [...driverResults, ...teamResults, ...circuitResults].slice(0, 8);
  }, [query, drivers, constructors, races, circuitDetails]);

  const handleSelect = (result: SearchResult) => {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();

    if (result.kind === "driver") {
      setSelectedDriver(result);
    } else if (result.kind === "circuit") {
      setSelectedCircuit(result);
    } else {
      router.push("/teams");
    }
  };

  const selectedDriverColor = selectedDriver
    ? getTeamColor(selectedDriver.driver.Constructors?.[0]?.name ?? "—")
    : null;
  const selectedDriverImg = selectedDriver
    ? hasDriverImage(selectedDriver.driver.Driver.givenName, selectedDriver.driver.Driver.familyName)
      ? getDriverImagePath(selectedDriver.driver.Driver.givenName, selectedDriver.driver.Driver.familyName)
      : null
    : null;
  const selectedDriverFlag = selectedDriver
    ? getFlagPath(selectedDriver.driver.Driver.nationality)
    : null;

  return (
    <div className="relative hidden lg:block" ref={rootRef}>
      <div className="flex items-center gap-[9px] bg-[rgba(245,235,222,0.06)] backdrop-blur-[10px] border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] rounded-xl px-[14px] py-[9px] w-[208px] focus-within:border-[rgba(255,138,61,0.5)] transition-colors duration-150">
        <Search className="w-3 h-3 text-[#8f867a] flex-none" strokeWidth={2} />
        <input
          ref={inputRef}
          className="flex-1 min-w-0 bg-transparent border-none outline-none font-medium text-xs text-on-background placeholder:text-warm-500"
          placeholder="Search drivers, tracks…"
          aria-label="Search"
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (query.trim().length >= 2) setOpen(true);
          }}
        />
      </div>

      <AnimatePresence>
        {open && query.trim().length >= 2 && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            transition={{ duration: reduce ? 0.1 : 0.16, ease: EASE_OUT }}
            style={{ transformOrigin: "top" }}
            role="listbox"
            className="absolute top-full right-0 mt-1.5 w-[280px] rounded-xl bg-[rgba(26,22,19,0.98)] border border-white/10 shadow-2xl z-50 max-h-80 overflow-y-auto p-1"
          >
            {results.length === 0 ? (
              <div className="px-3 py-4 text-center font-medium text-xs text-warm-500">
                No results for &ldquo;{query.trim()}&rdquo;
              </div>
            ) : (
              results.map((result) => (
                <div
                  key={result.key}
                  role="option"
                  aria-selected={false}
                  onClick={() => handleSelect(result)}
                  className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg cursor-pointer hover:bg-white/[0.05] transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-xs truncate">{result.label}</div>
                    <div className="font-medium text-[10px] text-warm-500 truncate">
                      {result.sublabel}
                    </div>
                  </div>
                  <span className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-600 flex-none">
                    {result.kind}
                  </span>
                </div>
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {selectedDriver && selectedDriverColor && (
        <DriverModal
          key={selectedDriver.key}
          driver={selectedDriver.driver}
          imgPath={selectedDriverImg}
          flagSrc={selectedDriverFlag}
          color={selectedDriverColor}
          onClose={() => setSelectedDriver(null)}
        />
      )}

      {selectedCircuit && (
        <CircuitDetailsModal
          isOpen
          onClose={() => setSelectedCircuit(null)}
          circuit={selectedCircuit.detail}
          circuitImagePath={selectedCircuit.circuitImagePath}
          flagPath={selectedCircuit.flagPath}
        />
      )}
    </div>
  );
}

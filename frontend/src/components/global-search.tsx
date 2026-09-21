"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { track } from "@/lib/analytics";

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

/**
 * `"nav"` is the desktop bar: a fixed-width pill that hides itself below `lg`
 * and drops its results right-aligned beneath the field.
 *
 * `"sheet"` is the phone's More sheet (`mobile-more-sheet.tsx`), which is the
 * only place search exists below `lg`. It differs in presentation ONLY — full
 * width, no `hidden lg:block`, results aligned left and sized to the field —
 * because the search behaviour, its ARIA and its result modals are exactly
 * what a phone should get too.
 */
type SearchVariant = "nav" | "sheet";

export default function GlobalSearch({
  variant = "nav",
  onDetailOpenChange,
}: {
  variant?: SearchVariant;
  /**
   * Fires when a result's own modal opens or closes.
   *
   * Only the sheet variant needs this, and it needs it for a specific reason:
   * `useModalDialog` binds Escape and its Tab trap to `window` with no
   * stacking, so a dialog opened from inside another dialog leaves two live
   * traps. Escape would close both at once, and the outer trap would keep
   * yanking focus back out of the inner modal. The sheet uses this to stand
   * down while a driver or circuit modal is on top of it.
   */
  onDetailOpenChange?: (open: boolean) => void;
} = {}) {
  const isSheet = variant === "sheet";
  const router = useRouter();
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  // Stable across server/client render, which `aria-controls` and
  // `aria-activedescendant` both need — they are attribute values pointing at
  // real ids, so a mismatched pair hydrates into a broken reference.
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // The active option in the ARIA sense: highlighted and the target of Enter,
  // but *not* holding DOM focus. Focus stays in the input for the whole
  // interaction (that is the point of `aria-activedescendant`) so the user can
  // keep typing to refine the query while an option is active. `null` means no
  // option is active, which is the state a freshly-typed query starts in —
  // auto-activating the first result would make Enter select something the
  // user never chose.
  //
  // Stored as the result's key rather than its index, which is what keeps the
  // highlight honest across a re-query: an index survives a keystroke and comes
  // to mean a different row, so Enter would open something the user never
  // highlighted. A key that is no longer in the list resolves to -1 on its own,
  // and one that merely moved follows its row.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<DriverStanding[]>([]);
  const [constructors, setConstructors] = useState<ConstructorStanding[]>([]);
  const [races, setRaces] = useState<Race[]>([]);
  const [circuitDetails, setCircuitDetails] = useState<CircuitDetail[]>([]);
  /**
   * Whether the four season fetches below have settled.
   *
   * Without this the popup renders `No results for "hamilton"` while the data
   * is still in flight — a confident wrong answer, and the worst thing a
   * search box can say. It was invisible in the nav, which mounts at page load
   * and is warm long before anyone reaches for it; the More sheet mounts this
   * component only when the sheet opens, so the very first search a phone user
   * ever runs is the one that raced.
   */
  const [loaded, setLoaded] = useState(false);

  const [selectedDriver, setSelectedDriver] = useState<DriverResult | null>(null);
  const [selectedCircuit, setSelectedCircuit] = useState<CircuitResult | null>(null);

  // Reported from an effect rather than from `handleSelect`/`onClose`, so the
  // two ways a modal can close (its own button, Escape) cannot disagree.
  const detailOpen = selectedDriver !== null || selectedCircuit !== null;
  const onDetailOpenChangeRef = useRef(onDetailOpenChange);
  useEffect(() => {
    onDetailOpenChangeRef.current = onDetailOpenChange;
  });
  useEffect(() => {
    onDetailOpenChangeRef.current?.(detailOpen);
  }, [detailOpen]);

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
      setLoaded(true);
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
        setActiveKey(null);
        // Deliberately no longer blurs. Escape on an open combobox dismisses
        // the popup and *keeps* focus on the input — blurring dumps a keyboard
        // user back at the top of the tab order, which is the same
        // "focus goes nowhere" failure the modals had.
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

  const popupOpen = open && query.trim().length >= 2;
  const activeIndex =
    activeKey === null ? -1 : results.findIndex((r) => r.key === activeKey);

  // The popup scrolls at `max-h-80`, so an option walked past its edge has to
  // be brought back. Indexed through `children` rather than by id: `useId`
  // produces colons, which are not valid in a bare CSS id selector.
  useEffect(() => {
    if (activeIndex < 0) return;
    const el = listboxRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Reopens a popup dismissed with Escape without needing another keystroke
      // in the field, which is the APG combobox behaviour.
      if (!popupOpen) {
        if (query.trim().length >= 2) {
          e.preventDefault();
          setOpen(true);
        }
        return;
      }
      if (results.length === 0) return;
      e.preventDefault();
      // Wraps at both ends. From "no active option" (-1) one expression covers
      // both directions: down lands on the first, up on the last.
      const next =
        e.key === "ArrowDown"
          ? activeIndex >= results.length - 1
            ? 0
            : activeIndex + 1
          : activeIndex <= 0
            ? results.length - 1
            : activeIndex - 1;
      setActiveKey(results[next].key);
      return;
    }

    if (e.key === "Home" || e.key === "End") {
      if (!popupOpen || results.length === 0) return;
      e.preventDefault();
      setActiveKey(results[e.key === "Home" ? 0 : results.length - 1].key);
      return;
    }

    if (e.key === "Enter") {
      // Only when an option was actually chosen. Enter on a typed query with
      // nothing active does nothing rather than guessing at the first result.
      if (popupOpen && activeIndex >= 0 && activeIndex < results.length) {
        e.preventDefault();
        handleSelect(results[activeIndex]);
      }
      return;
    }

    if (e.key === "Tab" && popupOpen) {
      // Tab leaves the combobox, so the popup must not be left hanging open
      // over the page with focus somewhere else entirely.
      setOpen(false);
      setActiveKey(null);
    }
  };

  const handleSelect = (result: SearchResult) => {
    // The KIND only. The query is free text a user typed, and free text never
    // leaves this app -- the open question is whether nav search is used and
    // for what sort of thing, which a kind answers on its own.
    track("search_result_selected", { entity_kind: result.kind });
    setOpen(false);
    setQuery("");
    setActiveKey(null);
    // Deliberately does NOT blur. Driver and circuit results open a modal, and
    // `useModalDialog` restores focus to whatever was focused when it mounted --
    // blurring first makes that `document.body`, so closing the modal would
    // strand a keyboard user at the top of the page rather than back in the
    // field they searched from.

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
    <div
      className={isSheet ? "relative" : "relative hidden lg:block"}
      ref={rootRef}
    >
      <div
        className={`flex items-center gap-[9px] bg-veil/6 backdrop-blur-[10px] border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] rounded-xl px-[14px] focus-within:border-flame-bright/50 transition-colors duration-150 ${
          /* 44px tall in the sheet: this is the one search field people will
             hit with a thumb, and the nav's 9px padding leaves it at 33. */
          isSheet ? "py-3 w-full" : "py-[9px] w-[208px]"
        }`}
      >
        <Search className="w-3 h-3 text-warm-400 flex-none" strokeWidth={2} />
        <input
          ref={inputRef}
          className="flex-1 min-w-0 bg-transparent border-none outline-none font-medium text-xs text-on-background placeholder:text-warm-500"
          placeholder="Search drivers, tracks…"
          aria-label="Search"
          type="text"
          /* The listbox had `role="listbox"` and no owning combobox, which is
             invalid on its own: nothing told a screen reader this field
             controlled it, and nothing announced the highlighted row.
             `aria-activedescendant` is what lets the highlight move while DOM
             focus stays in the input, so typing keeps working throughout. */
          role="combobox"
          aria-expanded={popupOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            popupOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (query.trim().length >= 2) setOpen(true);
          }}
          onKeyDown={handleInputKeyDown}
        />
      </div>

      <AnimatePresence>
        {popupOpen && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            transition={{ duration: reduce ? 0.1 : 0.16, ease: EASE_OUT }}
            style={{ transformOrigin: "top" }}
            className={`absolute top-full mt-1.5 rounded-xl bg-surface-container/98 border border-white/10 shadow-2xl z-50 max-h-80 overflow-y-auto p-1 ${
              /* Right-aligned in the nav because the field sits at the right
                 edge of a 1440px bar; left-aligned and field-width in the
                 sheet, where a 280px popup pinned right would hang off-centre
                 over a 358px row. */
              isSheet ? "left-0 right-0" : "right-0 w-[280px]"
            }`}
          >
            {/* The listbox is rendered even when empty and the "no results"
                line sits outside it. An empty listbox is valid; a listbox whose
                only child is a bare div is not, and an `aria-controls` pointing
                at an element that comes and goes is worse than one pointing at
                an empty one. */}
            <div
              ref={listboxRef}
              id={listboxId}
              role="listbox"
              aria-label="Search results"
            >
              {results.map((result, index) => (
                <div
                  key={result.key}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  onClick={() => handleSelect(result)}
                  /* Pointer and keyboard drive the same highlight, so moving
                     the mouse never leaves a second row looking active
                     somewhere else in the list. */
                  onPointerMove={() => setActiveKey(result.key)}
                  className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                    index === activeIndex ? "bg-white/[0.07]" : ""
                  }`}
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
              ))}
            </div>

            {results.length === 0 && (
              <div
                role="status"
                className="px-3 py-4 text-center font-medium text-xs text-warm-500"
              >
                {loaded ? (
                  <>No results for &ldquo;{query.trim()}&rdquo;</>
                ) : (
                  <>Loading the season&hellip;</>
                )}
              </div>
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

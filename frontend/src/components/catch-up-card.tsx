"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDownRight, ArrowUpRight, ChevronDown } from "lucide-react";
import {
  getCatchUp,
  getSeasonRaces,
  type CatchUpFacts,
  type CatchUpLeader,
  type CatchUpPerson,
  type CatchUpResponse,
  type CatchUpRound,
  type Race,
} from "@/lib/api";
import {
  CATCH_UP_READ_MS,
  applyHiddenRounds,
  markCatchUpRead,
  planCatchUp,
  readCatchUpState,
  stateForVisitWithoutCard,
  writeCatchUpState,
  type CatchUpPlan,
  type StorageLike,
} from "@/lib/catch-up";
import { getTeamColor } from "@/lib/team-colors";
import { EASE_OUT } from "@/components/motion-primitives";

/**
 * "Catch me up": what happened since a returning visitor's last visit.
 *
 * Self-contained: give it the season (and the schedule, if the page already
 * has it) and it decides on its own whether to appear. The rules live in
 * `lib/catch-up.ts`; this file fetches and renders.
 *
 * Facts first, narrative second. The rounds and the championship facts come
 * from one fast request and render as soon as it lands; the AI summary is a
 * second request that may take seconds, may come back null, and is only ever
 * added on top. If the model is down the card is complete without it.
 *
 * The visit is marked seen only by "Got it" or once the card has been on
 * screen, expanded, in a foreground tab, for `CATCH_UP_READ_MS`. A tab opened
 * and closed in a second leaves the update waiting for next time.
 *
 * `hiddenRoundKeys` is for spoiler-free mode: those rounds' results are left
 * out, and so are the championship facts and the narrative (both span every
 * missed round, so either would give a hidden result away). If every missed
 * round is hidden the card does not render at all.
 */

/** The most recent rounds listed in full; older ones collapse to a count. */
const MAX_ROUNDS_SHOWN = 5;

interface CatchUpCardProps {
  season: number;
  /** The season's schedule, if the page already has it; fetched otherwise. */
  races?: Race[];
  /** `${season}-${round}` keys whose results must not be shown. */
  hiddenRoundKeys?: string[];
}

type Phase = "idle" | "loading" | "ready" | "gone";

function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function familyName(person: CatchUpPerson | null | undefined): string {
  const parts = (person?.name ?? "").trim().split(/\s+/);
  return parts[parts.length - 1] || person?.code || "—";
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

function shortRaceName(name: string | null | undefined): string {
  return (name ?? "").replace(/ Grand Prix\b/, " GP") || "This round";
}

function pts(value: number): string {
  return `${value} pt${value === 1 ? "" : "s"}`;
}

export default function CatchUpCard({ season, races, hiddenRoundKeys }: CatchUpCardProps) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<CatchUpPlan | null>(null);
  const [data, setData] = useState<CatchUpResponse | null>(null);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [narrativePending, setNarrativePending] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const rootRef = useRef<HTMLElement | null>(null);
  const markedRef = useRef(false);

  const hiddenKey = (hiddenRoundKeys ?? []).join(",");

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      const storage = browserStorage();
      const nowMs = Date.now();
      let schedule = races;
      if (!schedule) {
        try {
          schedule = (await getSeasonRaces(season)).races ?? [];
        } catch {
          return; // No schedule, no way to tell what was missed.
        }
      }
      if (cancelled) return;

      const state = readCatchUpState(storage);
      const nextPlan = planCatchUp(season, schedule, state, nowMs);
      const quietVisit = stateForVisitWithoutCard(season, schedule, state, nextPlan, nowMs);
      if (quietVisit) writeCatchUpState(storage, quietVisit);
      if (!nextPlan) return;

      const hidden = new Set(hiddenKey ? hiddenKey.split(",") : []);
      if (nextPlan.missedRoundKeys.every((key) => hidden.has(key))) return;

      setPlan(nextPlan);
      setPhase("loading");

      let facts: CatchUpResponse;
      try {
        facts = await getCatchUp(season, nextPlan.afterRound, {
          narrative: false,
          signal: controller.signal,
        });
      } catch {
        if (!cancelled) setPhase("gone");
        return;
      }
      if (cancelled) return;

      const { visible, anyHidden } = applyHiddenRounds(facts.rounds, hiddenKey ? hiddenKey.split(",") : []);
      if (visible.length === 0) {
        // Results not synced yet (or all hidden): nothing to say, and the
        // visit is NOT marked, so the card is still owed next time.
        setPhase("gone");
        return;
      }

      setData(facts);
      setNarrative(anyHidden ? null : facts.narrative);
      setPhase("ready");

      if (anyHidden || facts.narrative) return;
      setNarrativePending(true);
      try {
        const withNarrative = await getCatchUp(season, nextPlan.afterRound, {
          narrative: true,
          signal: controller.signal,
        });
        // Only if it describes the same span the facts on screen describe.
        if (!cancelled && withNarrative.latest_round === facts.latest_round) {
          setNarrative(withNarrative.narrative);
        }
      } catch {
        // Progressive enhancement: the facts already stand on their own.
      } finally {
        if (!cancelled) setNarrativePending(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [season, races, hiddenKey]);

  const anyHidden = data ? applyHiddenRounds(data.rounds, hiddenRoundKeys).anyHidden : false;

  // "Plausibly read": on screen (half of it at least), expanded, tab in the
  // foreground, for CATCH_UP_READ_MS in total. Not while spoiler-free mode is
  // hiding rounds: marking would skip past results the visitor never saw.
  useEffect(() => {
    const node = rootRef.current;
    if (phase !== "ready" || !plan || !expanded || anyHidden || markedRef.current || !node) return;
    if (typeof IntersectionObserver === "undefined") return;

    let onScreen = false;
    let readMs = 0;
    let last = performance.now();
    const observer = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting && entry.intersectionRatio >= 0.5;
      },
      { threshold: [0, 0.5, 1] }
    );
    observer.observe(node);

    const timer = window.setInterval(() => {
      const now = performance.now();
      if (onScreen && document.visibilityState === "visible") readMs += now - last;
      last = now;
      if (readMs >= CATCH_UP_READ_MS && !markedRef.current) {
        markedRef.current = true;
        writeCatchUpState(browserStorage(), markCatchUpRead(plan));
        window.clearInterval(timer);
      }
    }, 500);

    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [phase, plan, expanded, anyHidden]);

  function dismiss() {
    if (plan) {
      markedRef.current = true;
      writeCatchUpState(browserStorage(), markCatchUpRead(plan));
    }
    setPhase("gone");
  }

  const show = phase === "loading" || phase === "ready";

  return (
    <AnimatePresence initial={false}>
      {show && plan && (
        <motion.section
          key="catch-up"
          ref={rootRef}
          aria-labelledby="catch-up-title"
          className="px-6 md:px-10 pb-8"
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -8, transition: { duration: 0.2, ease: EASE_OUT } }}
          transition={{ duration: 0.45, ease: EASE_OUT }}
        >
          <div className="apex-glass apex-sheen rounded-panel p-5 md:p-[26px] overflow-hidden">
            <Header
              plan={plan}
              data={data}
              hiddenCount={data ? data.rounds.length - applyHiddenRounds(data.rounds, hiddenRoundKeys).visible.length : 0}
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              onDismiss={dismiss}
            />

            <AnimatePresence initial={false}>
              {expanded && (
                <motion.div
                  key="body"
                  id="catch-up-body"
                  initial={reduce ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduce ? { height: 0, opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.3, ease: EASE_OUT }}
                  className="overflow-hidden"
                >
                  {phase === "loading" || !data ? (
                    <Skeleton reduce={!!reduce} />
                  ) : (
                    <Body
                      season={season}
                      plan={plan}
                      data={data}
                      hiddenRoundKeys={hiddenRoundKeys}
                      anyHidden={anyHidden}
                      narrative={narrative}
                      narrativePending={narrativePending}
                      reduce={!!reduce}
                    />
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function Header({
  plan,
  data,
  hiddenCount,
  expanded,
  onToggle,
  onDismiss,
}: {
  plan: CatchUpPlan;
  data: CatchUpResponse | null;
  hiddenCount: number;
  expanded: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  const lastVisit = new Date(plan.lastSeenAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(plan.fromPreviousSeason ? { year: "numeric" } : {}),
  });
  const rounds = data?.rounds.length ?? plan.missedRoundKeys.length;
  const summary = plan.fromPreviousSeason
    ? `Your last visit was on ${lastVisit}, in the ${plan.lastSeenSeason} season · showing ${plan.season} only`
    : data?.baseline.race_name
      ? `${rounds} round${rounds === 1 ? "" : "s"} since your visit on ${lastVisit}, after the ${data.baseline.race_name}`
      : `${rounds} round${rounds === 1 ? "" : "s"} since your visit on ${lastVisit}`;

  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <span className="font-bold text-[11px] tracking-[0.14em] uppercase text-flame">Catch me up</span>
        <h2
          id="catch-up-title"
          className="font-[family-name:var(--font-headline)] font-bold text-[22px] md:text-[26px] leading-[1.1] mt-1.5"
        >
          Since you were last here
        </h2>
        <p className="font-semibold text-xs text-warm-400 mt-1.5">
          {summary}
          {hiddenCount > 0 && ` · ${hiddenCount} hidden by spoiler-free mode`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls="catch-up-body"
          aria-label={expanded ? "Collapse catch-up" : "Expand catch-up"}
          className="relative before:absolute before:-inset-1 before:content-[''] flex h-10 w-10 items-center justify-center rounded-control text-warm-300 hover:text-on-background hover:bg-white/[0.06] transition-colors outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          <ChevronDown
            size={18}
            aria-hidden="true"
            className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="h-10 rounded-control px-4 font-bold text-[13px] text-on-background bg-primary-container/80 hover:bg-primary-container transition-[background-color,transform] duration-150 active:scale-[0.97] outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          Got it
        </button>
      </div>
    </div>
  );
}

function Skeleton({ reduce }: { reduce: boolean }) {
  return (
    <div className={`mt-5 grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] ${reduce ? "" : "animate-pulse"}`} aria-hidden="true">
      <div className="space-y-2.5">
        {[0, 1].map((i) => (
          <div key={i} className="h-[74px] rounded-tile bg-white/[0.05]" />
        ))}
      </div>
      <div className="space-y-2.5">
        <div className="h-[46px] rounded-tile bg-white/[0.05]" />
        <div className="h-[46px] rounded-tile bg-white/[0.05]" />
        <div className="h-[46px] rounded-tile bg-white/[0.05]" />
      </div>
      <span className="sr-only">Loading what you missed</span>
    </div>
  );
}

function Body({
  season,
  plan,
  data,
  hiddenRoundKeys,
  anyHidden,
  narrative,
  narrativePending,
  reduce,
}: {
  season: number;
  plan: CatchUpPlan;
  data: CatchUpResponse;
  hiddenRoundKeys?: string[];
  anyHidden: boolean;
  narrative: string | null;
  narrativePending: boolean;
  reduce: boolean;
}) {
  const { visible } = applyHiddenRounds(data.rounds, hiddenRoundKeys);
  const shown = visible.slice(-MAX_ROUNDS_SHOWN).reverse();
  const earlier = visible.length - shown.length;
  const seenSprints = new Set(plan.seenSprintRoundKeys);
  const facts = data.facts;

  return (
    <div className="mt-5">
      {(narrative || narrativePending) && (
        <div className="mb-5">
          {narrative ? (
            <p className="font-medium text-[15px] leading-[1.65] text-warm-200 max-w-[70ch]">{narrative}</p>
          ) : (
            <p className="flex items-center gap-2 text-[13px] text-warm-400">
              <span
                className={`w-1.5 h-1.5 rounded-full bg-flame ${reduce ? "" : "animate-pulse"}`}
                aria-hidden="true"
              />
              Writing a short summary…
            </p>
          )}
          {narrative && (
            <p className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500 mt-2">
              AI summary · written only from the results below, and checked against them
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <ul className="space-y-2.5">
            {shown.map((round) => (
              <li key={round.round_key}>
                <RoundRow season={season} round={round} hideSprint={seenSprints.has(round.round_key)} />
              </li>
            ))}
          </ul>
          {earlier > 0 && (
            <Link
              href={`/schedule?season=${season}`}
              className="mt-3 inline-flex min-h-10 items-center text-xs font-semibold text-warm-400 hover:text-on-background transition-colors"
            >
              + {earlier} earlier round{earlier === 1 ? "" : "s"} on the schedule
            </Link>
          )}
        </div>

        <Championship facts={facts} anyHidden={anyHidden} baselineRound={data.after_round} />
      </div>
    </div>
  );
}

function RoundRow({ season, round, hideSprint }: { season: number; round: CatchUpRound; hideSprint: boolean }) {
  const winner = round.race.winner;
  const color = getTeamColor(winner?.team ?? undefined).hex;
  const sprint = !hideSprint && round.sprint?.status === "classified" ? round.sprint : null;

  return (
    <Link
      href={`/schedule/${season}/${round.round}`}
      className="group block apex-glass-soft rounded-tile px-4 py-3 hover:bg-white/[0.06] transition-colors outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
    >
      <div className="flex items-center gap-2 text-[11px] font-bold tracking-[0.1em] uppercase text-warm-400">
        <span className="text-flame">R{round.round}</span>
        <span className="truncate">{round.race_name}</span>
        <span className="ml-auto text-warm-500 group-hover:text-warm-300 transition-colors" aria-hidden="true">
          →
        </span>
      </div>

      {round.race.status === "classified" && winner ? (
        <div className="mt-2 flex items-center gap-2.5 min-w-0">
          <span className="h-7 w-[3px] shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-bold text-[15px] leading-tight truncate">
              {winner.name} <span className="font-semibold text-xs text-warm-400">won · {winner.team}</span>
            </div>
            <div className="text-xs text-warm-400 mt-0.5 truncate">
              {round.race.podium
                .filter((p) => p.position > 1)
                .map((p) => `P${p.position} ${familyName(p)}`)
                .join(" · ")}
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[13px] text-warm-400">
          {round.race.status === "pending" ? "Grand Prix not classified yet" : "No Grand Prix result on file"}
        </p>
      )}

      {sprint?.winner && (
        <p className="mt-1.5 text-xs text-warm-300">
          <span className="font-bold text-warm-400">Sprint</span> · {sprint.winner.name} won
          {sprint.podium.length > 1 &&
            `, ${sprint.podium
              .filter((p) => p.position > 1)
              .map((p) => `P${p.position} ${familyName(p)}`)
              .join(" · ")}`}
        </p>
      )}
    </Link>
  );
}

function leaderLabel(leader: CatchUpLeader): string {
  return leader.tied
    ? `Level: ${leader.drivers.map((d) => familyName(d)).join(" & ")}`
    : leader.drivers[0]?.name ?? "—";
}

function Championship({
  facts,
  anyHidden,
  baselineRound,
}: {
  facts: CatchUpFacts | null;
  anyHidden: boolean;
  baselineRound: number;
}) {
  if (anyHidden) {
    return (
      <p className="apex-glass-soft rounded-tile px-4 py-3 text-[13px] text-warm-400 self-start">
        Championship changes are hidden while spoiler-free mode hides a round.
      </p>
    );
  }
  const standings = facts?.standings;
  const notable = facts?.notable ?? [];

  return (
    <div className="min-w-0 space-y-2.5 self-start">
      {standings ? (
        <>
          {standings.leader_now && (
            <Stat label="Championship leader">
              <span className="font-bold">{leaderLabel(standings.leader_now)}</span>
              <span className="text-warm-400"> · {pts(standings.leader_now.points)}</span>
              {standings.leader_changed && standings.leader_before && (
                <span className="block text-xs text-flame mt-0.5">
                  {standings.leader_now.tied
                    ? `Was ${leaderLabel(standings.leader_before)}`
                    : `Took the lead from ${leaderLabel(standings.leader_before)}`}
                </span>
              )}
            </Stat>
          )}

          {standings.title_gap_now && (
            <Stat label="Title gap">
              {standings.title_gap_before ? (
                <>
                  <span className="text-warm-400 tabular-nums">{pts(standings.title_gap_before.points)}</span>
                  <span className="text-warm-500"> after R{baselineRound} → </span>
                  <span className="font-bold tabular-nums">{pts(standings.title_gap_now.points)}</span>
                  <span className="text-warm-500"> now</span>
                </>
              ) : (
                <span className="font-bold tabular-nums">{pts(standings.title_gap_now.points)}</span>
              )}
              <span className="block text-xs text-warm-400 mt-0.5">
                {familyName(standings.title_gap_now.leader)} {standings.title_gap_now.leader_points} ·{" "}
                {familyName(standings.title_gap_now.second)} {standings.title_gap_now.second_points}
              </span>
            </Stat>
          )}

          {standings.movers.length > 0 && (
            <Stat label="Biggest movers">
              <ul className="space-y-1 mt-0.5">
                {standings.movers.map((m) => (
                  <li key={m.driver_id} className="flex items-center gap-1.5 text-[13px]">
                    {m.change > 0 ? (
                      <ArrowUpRight size={14} className="text-[#7ee0a1] shrink-0" aria-label="up" />
                    ) : (
                      <ArrowDownRight size={14} className="text-[#ff7a7a] shrink-0" aria-label="down" />
                    )}
                    <span className="font-semibold">{familyName(m)}</span>
                    <span className="text-warm-400 tabular-nums">
                      {ordinal(m.from_position)} → {ordinal(m.to_position)}
                    </span>
                  </li>
                ))}
              </ul>
            </Stat>
          )}

          {standings.top_scorer && (
            <Stat label="Most points since">
              <span className="font-bold">{standings.top_scorer.drivers.map((d) => familyName(d)).join(" & ")}</span>
              <span className="text-warm-400"> · {pts(standings.top_scorer.points)}</span>
            </Stat>
          )}
        </>
      ) : (
        <p className="apex-glass-soft rounded-tile px-4 py-3 text-[13px] text-warm-400">
          Championship standings could not be checked against the official table right now, so they are left out.
        </p>
      )}

      {notable.map((n) => (
        <p
          key={`${n.kind}-${n.round}-${n.session}-${n.driver.driver_id}`}
          className="apex-glass-soft rounded-tile px-4 py-2.5 text-[13px] text-warm-200"
        >
          <span className="font-bold text-flame">
            {n.kind === "first_career_win" ? "First career win" : "Leader didn't finish"}
          </span>{" "}
          · {n.driver.name}, {shortRaceName(n.race_name)}
          {n.session === "sprint" ? " sprint" : ""}
          {n.kind === "leader_non_finish" && n.status ? ` (${n.status})` : ""}
        </p>
      ))}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="apex-glass-soft rounded-tile px-4 py-2.5">
      <div className="font-bold text-[10px] tracking-[0.12em] uppercase text-warm-500 mb-1">{label}</div>
      <div className="text-[14px] leading-snug">{children}</div>
    </div>
  );
}

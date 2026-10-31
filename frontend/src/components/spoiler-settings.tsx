"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AUTO_REVEAL_CHOICES,
  serializeSpoilerPrefs,
  type HiddenRound,
} from "@/lib/spoilers";
import { useSpoilerCrossTabSync, useSpoilers } from "@/lib/spoilers-client";

/**
 * The spoiler-free controls: the eye in the desktop header, and the panel it
 * opens, which the phone's "More" sheet embeds as-is.
 *
 * The header lives in the root layout, which must stay free of `cookies()`
 * (see `lib/spoilers-server.ts`), so this reads the cookie in the browser.
 * Until hydration it renders the neutral eye: the icon is the only thing that
 * can be momentarily wrong, never a result.
 */

type HiddenState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; hidden: HiddenRound[] };

/**
 * The hidden-right-now list, asked of `/api/spoilers` so it is computed by the
 * same server code and the same cookie as the placeholders on the page (see
 * that route for why the browser does not work it out itself). Re-asked
 * whenever the preference changes, keyed on its serialised form.
 */
function useHiddenRounds(enabled: boolean, prefsKey: string): HiddenState {
  const [state, setState] = useState<HiddenState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/spoilers", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { hidden?: HiddenRound[] };
        if (!cancelled) setState({ status: "ready", hidden: body.hidden ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, prefsKey]);

  return state;
}

function Switch({
  checked,
  onChange,
  labelledBy,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  labelledBy: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative flex-none w-[46px] h-[28px] rounded-full border transition-colors duration-200 disabled:opacity-60 before:absolute before:-inset-2 before:content-[''] ${
        checked
          ? "bg-primary-container border-primary-container"
          : "bg-white/[0.08] border-white/[0.14]"
      }`}
    >
      <span
        className={`absolute top-[3px] left-[3px] w-5 h-5 rounded-full bg-on-background shadow-[0_2px_6px_rgba(0,0,0,0.4)] transition-transform duration-200 ease-[var(--ease-out-apex)] motion-reduce:transition-none ${
          checked ? "translate-x-[18px]" : ""
        }`}
      />
    </button>
  );
}

export function SpoilerSettingsPanel({ active = true }: { active?: boolean }) {
  const { prefs, ready, pending, setOn, setAutoRevealDays, reveal } = useSpoilers();
  const titleId = useId();
  const autoId = useId();

  const hiddenState = useHiddenRounds(active && ready && prefs.on, serializeSpoilerPrefs(prefs));

  return (
    <div className="text-left">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p id={titleId} className="font-bold text-sm text-on-background">
            Spoiler-free mode
          </p>
          <p className="font-medium text-xs text-warm-400 mt-1 leading-relaxed">
            Hides a round&apos;s results, winners and standings from its first
            qualifying or sprint session until you say you&apos;ve watched it.
          </p>
        </div>
        <Switch
          checked={prefs.on}
          onChange={setOn}
          labelledBy={titleId}
          disabled={!ready || pending}
        />
      </div>

      <div className="mt-4">
        <p id={autoId} className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500 mb-2">
          Reveal automatically
        </p>
        <div
          role="radiogroup"
          aria-labelledby={autoId}
          className="grid grid-cols-3 gap-1 apex-glass-soft rounded-xl p-1"
        >
          {AUTO_REVEAL_CHOICES.map((choice) => {
            const selected = prefs.autoRevealDays === choice.value;
            return (
              <button
                key={choice.label}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!ready || pending}
                onClick={() => setAutoRevealDays(choice.value)}
                className={`h-10 rounded-lg text-[11px] transition-colors duration-150 disabled:opacity-60 ${
                  selected
                    ? "bg-primary-container/18 text-primary font-bold"
                    : "text-warm-300 font-semibold hover:text-on-background"
                }`}
              >
                {choice.label}
              </button>
            );
          })}
        </div>
        <p className="font-medium text-[11px] text-warm-500 mt-1.5">
          Counted from the start of the grand prix.
        </p>
      </div>

      <div className="mt-4">
        <p className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500 mb-2">
          Hidden right now
        </p>
        {!prefs.on ? (
          <p className="font-medium text-xs text-warm-500">
            Nothing — the mode is off.
          </p>
        ) : hiddenState.status === "loading" ? (
          <p className="font-medium text-xs text-warm-500" role="status">
            Checking the calendar&hellip;
          </p>
        ) : hiddenState.status === "error" ? (
          <p className="font-medium text-xs text-warm-500" role="status">
            Couldn&apos;t load the calendar right now, so this list is
            unavailable. Try again in a moment.
          </p>
        ) : hiddenState.hidden.length === 0 ? (
          <p className="font-medium text-xs text-warm-500">
            Nothing. Rounds hide themselves when their first qualifying or
            sprint session starts.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {hiddenState.hidden.map((round) => (
              <li
                key={round.raceKey}
                className="flex items-center justify-between gap-3 rounded-xl bg-veil/5 border border-white/[0.06] pl-3 pr-1.5 py-1.5"
              >
                <span className="min-w-0">
                  <span className="block font-semibold text-xs text-on-background truncate">
                    {round.shortName}
                  </span>
                  <span className="block font-medium text-[10px] text-warm-500">
                    Round {round.round} · {round.season}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => reveal(round.raceKey)}
                  disabled={pending}
                  aria-label={`Reveal the ${round.raceName}`}
                  className="flex-none h-10 px-3.5 rounded-lg font-bold text-[11px] text-primary bg-primary-container/14 hover:bg-primary-container/22 transition-colors disabled:opacity-60"
                >
                  Reveal
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="font-medium text-[10px] text-warm-500 mt-4 leading-relaxed">
        Saved in a cookie on this device. It keeps results off the screen; the
        data can still reach your browser.
      </p>
    </div>
  );
}

/** The header control: an eye that opens the panel in a popover. */
export default function SpoilerToggle() {
  const { prefs, ready } = useSpoilers();
  // Mounted once per page via the header (in the DOM at every width; only
  // its visibility is responsive), so this is where cross-tab changes are
  // picked up. See the hook for why it is not inside `useSpoilers`.
  useSpoilerCrossTabSync();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const reduce = useReducedMotion();
  const on = ready && prefs.on;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative hidden lg:block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={on ? "Spoiler-free mode is on. Change settings" : "Spoiler-free mode"}
        title={on ? "Spoiler-free mode is on" : "Spoiler-free mode"}
        className={`relative h-10 rounded-full flex items-center justify-center gap-1.5 border transition-[border-color,background-color,color,transform] duration-150 active:scale-95 ${
          on
            ? "pl-3 pr-3.5 bg-primary-container/12 border-primary-container/40 text-primary"
            : "w-10 apex-glass-soft text-warm-300 hover:text-on-background"
        }`}
      >
        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
          {on ? "visibility_off" : "visibility"}
        </span>
        {/* The indicator: when the mode is on, the control says so in words,
            so someone wondering where the podium went has an answer in the
            chrome of every page, not only on the placeholders. */}
        {on && (
          <span className="hidden xl:inline font-bold text-[11px] tracking-[0.02em]">
            Spoiler-free
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id={panelId}
            role="dialog"
            aria-label="Spoiler-free mode settings"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -4 }}
            transition={{ duration: reduce ? 0.1 : 0.16, ease: [0.23, 1, 0.32, 1] }}
            style={{ transformOrigin: "top right" }}
            className="absolute right-0 top-[calc(100%+12px)] z-[70] w-[340px] rounded-2xl bg-surface-container-low/97 backdrop-blur-2xl border border-white/[0.1] shadow-[0_24px_60px_rgba(0,0,0,0.55)] p-4"
          >
            <SpoilerSettingsPanel active={open} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

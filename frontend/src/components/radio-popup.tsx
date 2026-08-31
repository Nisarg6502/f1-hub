"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Play, Pause, Radio } from "lucide-react";
import { useReducedMotion } from "motion/react";
import type { RadioClip } from "@/lib/api";
import { getTeamColor } from "@/lib/team-colors";
import { formatClipDuration, popupLines } from "@/lib/watch-radio";

/**
 * The broadcast team-radio box, over the replay.
 *
 * Modelled on F1's own on-screen graphic: bottom-left, a team-coloured edge, the
 * driver's surname, the quoted line beneath. The differences from the broadcast
 * are all deliberate and all forced by what the data actually is —
 *
 * **The speaker labels are inferred, not given.** No free source says who is
 * talking on a radio clip; `radio_attribution.py` works it out and abstains when
 * it cannot. So a line can be `unknown`, and an `unknown` line renders neutrally
 * under a `RADIO` label rather than being quietly assigned to the driver. The
 * colour split — driver lines in team colour, pit-wall lines in plain grey — is
 * what lets the eye separate the two voices without reading the labels, so a
 * guessed colour would be a lie told faster than the text.
 *
 * **Nothing plays until it is asked to.** Watch mode's premise is a phone
 * propped next to a broadcast that is already making noise, and the raw feed is
 * the pit-wall dump rather than the TV mix — F1 bleeps swearing before air and
 * this audio has not been through that. The caption is masked; the audio is not.
 * A tap is the gate between them. (Browsers block unprompted audio anyway, so
 * autoplay would have been a broken feature as well as a rude one.)
 *
 * **The waveform is decoration and does not pretend otherwise.** F1's CDN sends
 * no `Access-Control-Allow-Origin`, so an `<audio>` element can play the file
 * but Web Audio cannot read a single sample of it. A real waveform needs the
 * bytes proxied through our own origin; these bars are a CSS animation. They are
 * here because motion reads as "this is playing", not because they are data.
 */

/** Portalled to `document.body` for the reason `PairedToast` records: the
 * header and footer are both flex-none clipping contexts and the body is
 * `overflow-hidden`, so anything fixed-positioned inside the tree is one layout
 * change away from being cut off. */
export default function RadioPopup({
  clip,
  driver,
  onDismiss,
}: {
  clip: RadioClip | null;
  driver: { code?: string | null; name?: string | null; team?: string | null } | null;
  onDismiss?: () => void;
}) {
  const reduce = useReducedMotion();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /** *Which* clip is playing, not merely whether one is.
   *
   * Storing the id rather than a boolean is what lets a new clip reset the
   * control without an effect: `playing` is derived, so it falls to false the
   * moment `clipId` changes, and the effect below is left doing only what an
   * effect should — telling an external system (the audio element) about it.
   */
  const [playingId, setPlayingId] = useState<string | null>(null);

  const clipId = clip?.id ?? null;
  const playing = playingId !== null && playingId === clipId;

  // A new clip arriving while the previous one is still audible must stop that
  // audio rather than leave two voices overlapping — the one failure mode here
  // that sounds like a bug rather than looking like one.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
  }, [clipId]);

  if (!clip) return null;
  if (typeof document === "undefined") return null;

  const team = getTeamColor(driver?.team ?? undefined);
  const surname = (driver?.name ?? "").split(" ").slice(1).join(" ") || driver?.code || `#${clip.driver_number}`;
  const { lines, truncated } = popupLines(clip);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // `.play()` rejects when the browser declines (no gesture yet, or a
      // policy). Swallowing it keeps the button honest — it simply does not
      // switch to "pause" — rather than throwing an unhandled rejection into
      // the console of a page that is otherwise fine.
      audio
        .play()
        .then(() => setPlayingId(clipId))
        .catch(() => setPlayingId(null));
    } else {
      audio.pause();
      setPlayingId(null);
    }
  };

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed z-[55] rounded-2xl overflow-hidden"
      style={{
        left: "max(0.75rem, env(safe-area-inset-left, 0px) + 0.75rem)",
        bottom: "max(0.75rem, env(safe-area-inset-bottom, 0px) + 0.75rem)",
        width: "min(calc(100vw - 1.5rem), 420px)",
        // Opaque, not glass, and for the reason `PairedToast` already records:
        // this lands on top of a moving timing tower, and a translucent panel
        // over twenty rows of shifting numbers is the one place the house style
        // actively costs legibility.
        background: "linear-gradient(180deg,#241a13,#191210)",
        border: `1px solid ${team.hex}59`,
        boxShadow: "0 20px 50px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.10)",
        animation: reduce
          ? "apex-radio-fade 200ms var(--ease-out-apex) both"
          : "apex-radio-in 320ms var(--ease-out-apex) both",
      }}
    >
      {/* The team-coloured edge. A block, not a border, so it can carry a glow
          without the border-radius clipping it into a crescent. */}
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-[4px]"
        style={{ background: team.hex, boxShadow: `0 0 14px ${team.glow}` }}
      />

      <div className="pl-4 pr-3 py-2.5">
        <div className="flex items-center gap-2">
          <Radio size={13} className="flex-none" style={{ color: team.hex }} />
          <span
            className="font-extrabold text-[13px] leading-none truncate"
            style={{ color: team.hex }}
          >
            {surname.toUpperCase()}
          </span>
          <span className="font-bold text-[9px] tracking-[0.18em] uppercase text-warm-500 leading-none">
            Team radio
          </span>
          {typeof clip.lap === "number" && (
            <span className="ml-auto font-bold text-[10px] tabular-nums text-warm-500 leading-none flex-none">
              LAP {clip.lap}
            </span>
          )}
        </div>

        <div className="mt-2 flex flex-col gap-1">
          {lines.map((utterance, index) => {
            const isDriver = utterance.speaker === "driver";
            const isPit = utterance.speaker === "pit";
            return (
              <p key={index} className="flex gap-2 items-baseline">
                <span
                  className="font-bold text-[9px] tracking-[0.1em] tabular-nums flex-none w-[34px] leading-[1.45]"
                  style={{ color: isDriver ? team.hex : "var(--color-warm-500)" }}
                >
                  {isDriver ? (driver?.code ?? "CAR") : isPit ? "PIT" : "RADIO"}
                </span>
                <span
                  className="font-medium text-[12px] md:text-[13px] leading-[1.45] min-w-0"
                  style={{ color: isDriver ? "var(--color-warm-100)" : "var(--color-warm-300)" }}
                >
                  &ldquo;{utterance.text}&rdquo;
                </span>
              </p>
            );
          })}
          {truncated > 0 && (
            // Never silently capped. The Pitwall module has the whole thing;
            // this says so rather than ending mid-exchange.
            <p className="font-semibold text-[10px] text-warm-500 pl-[42px]">
              +{truncated} more line{truncated === 1 ? "" : "s"} in this message
            </p>
          )}
          {lines.length === 0 && (
            <p className="font-medium text-[12px] text-warm-400 italic">
              Radio message — no transcript available
            </p>
          )}
        </div>

        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? "Pause radio clip" : "Play radio clip"}
            className="flex items-center justify-center w-[26px] h-[26px] rounded-full flex-none transition-transform duration-150 active:scale-90"
            style={{ background: `${team.hex}26`, color: team.hex, border: `1px solid ${team.hex}59` }}
          >
            {playing ? <Pause size={12} /> : <Play size={12} />}
          </button>

          {/* Decoration, not data — see the component docstring. */}
          <span aria-hidden className="flex items-end gap-[2px] h-[13px]">
            {[0, 1, 2, 3].map((bar) => (
              <span
                key={bar}
                className="w-[2px] rounded-full"
                style={{
                  background: team.hex,
                  height: playing && !reduce ? undefined : "3px",
                  opacity: playing ? 0.9 : 0.35,
                  animation:
                    playing && !reduce
                      ? `apex-radio-bar 900ms ${bar * 110}ms ease-in-out infinite`
                      : undefined,
                }}
              />
            ))}
          </span>

          <span className="font-bold text-[10px] tabular-nums text-warm-500">
            {formatClipDuration(clip.duration_s)}
          </span>

          {clip.strong_language && (
            <span className="font-bold text-[9px] tracking-[0.1em] uppercase text-warm-500">
              Explicit audio
            </span>
          )}

          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="ml-auto font-bold text-[10px] text-warm-500 hover:text-warm-300 transition-colors duration-150"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>

      {/* `preload="none"`: a race can carry forty clips, and preloading each as
          it pops would pull megabytes off F1's CDN for audio nobody asked to
          hear. No `crossOrigin` — the CDN sends no CORS header, and setting it
          would break playback outright rather than enable anything. */}
      <audio
        ref={audioRef}
        src={clip.url}
        preload="none"
        onEnded={() => setPlayingId(null)}
        onPause={() => setPlayingId(null)}
      />
    </div>,
    document.body
  );
}

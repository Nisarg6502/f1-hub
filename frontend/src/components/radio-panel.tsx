"use client";

import { useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Pause, Play, Radio, Search } from "lucide-react";
import type { RadioClip } from "@/lib/api";
import { formatClipDuration } from "@/lib/watch-radio";

/**
 * The full team-radio feed for one session — the Pitwall's sibling to Race
 * Control, and the place where nothing is hidden.
 *
 * The watch-mode popup is a highlight reel by necessity: it shows one clip at a
 * time, for six seconds, over a moving tower, and it skips anything the viewer
 * scrubbed past. This is the other half of that contract. **Every clip F1
 * published appears here**, including the ones the popup can never show — radio
 * from before lights out, radio after the flag, and clips whose transcription
 * produced nothing. That is what makes the popup's filtering acceptable rather
 * than lossy.
 *
 * Two things worth knowing before reading the render:
 *
 * **`speaker` is inferred and often `unknown`.** No free source says who is
 * talking on a team-radio clip. `radio_attribution.py` works it out from the
 * transcript and abstains below a confidence floor, so a line can honestly be
 * neither the driver nor the pit wall. Those render under a neutral `RADIO`
 * label — never silently attributed to the driver.
 *
 * **Audio plays on tap and is never autoplayed.** The feed is F1's raw pit-wall
 * dump, not the broadcast mix, so it has not been bleeped; the caption is masked
 * and the audio is not. One `<audio>` element is shared by the whole list rather
 * than one per row, which is what stops two clips ever playing over each other.
 */

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

interface PanelDriver {
  number: string;
  code: string;
  givenName: string;
  familyName: string;
  teamColor: string;
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="apex-glass-soft rounded-2xl px-5 py-4">
      <div className="font-bold text-[10px] tracking-[0.16em] uppercase text-warm-500">
        {label}
      </div>
      <div className="font-[family-name:var(--font-headline)] font-extrabold text-2xl tabular-nums mt-1.5">
        {value}
      </div>
      {hint && <div className="font-semibold text-[11px] text-warm-500 mt-0.5">{hint}</div>}
    </div>
  );
}

function formatClock(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false });
}

/**
 * When a clip sits outside the race, say so rather than showing nothing.
 *
 * A negative `t_ms` is grid and formation radio; a null one is a session this
 * app could not anchor to a measured start (a sprint, or a round whose timing
 * has not been rebuilt). Both are real messages, and both are invisible in watch
 * mode, so this is the only place they are ever seen.
 */
function whenLabel(clip: RadioClip): string {
  if (typeof clip.lap === "number") return `Lap ${clip.lap}`;
  if (typeof clip.t_ms === "number" && clip.t_ms < 0) return "Before lights out";
  return "Off the race clock";
}

export default function RadioPanel({
  drivers,
  clips,
}: {
  drivers: PanelDriver[];
  clips: RadioClip[];
}) {
  const reduce = useReducedMotion();
  const [driverFilter, setDriverFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const driverByNumber = useMemo(
    () => new Map(drivers.map((d) => [String(d.number), d])),
    [drivers]
  );

  /** Only drivers who actually appear, in order of how much they were heard.
   *  A quiet race leaves half the grid off this list entirely, which is the
   *  truth about the feed rather than a gap in it. */
  const heard = useMemo(() => {
    const counts = new Map<string, number>();
    for (const clip of clips) {
      counts.set(clip.driver_number, (counts.get(clip.driver_number) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([number, count]) => ({
        number,
        count,
        driver: driverByNumber.get(number),
      }));
  }, [clips, driverByNumber]);

  const stats = useMemo(() => {
    const seconds = clips.reduce((total, clip) => total + (clip.duration_s ?? 0), 0);
    const longest = clips.reduce(
      (best, clip) => ((clip.duration_s ?? 0) > (best?.duration_s ?? 0) ? clip : best),
      null as RadioClip | null
    );
    return {
      total: clips.length,
      drivers: heard.length,
      minutes: seconds / 60,
      longest,
    };
  }, [clips, heard]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return clips.filter((clip) => {
      if (driverFilter && clip.driver_number !== driverFilter) return false;
      if (!needle) return true;
      const driver = driverByNumber.get(clip.driver_number);
      const haystack = [
        driver?.code,
        driver?.familyName,
        ...clip.utterances.map((u) => u.text),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [clips, driverFilter, query, driverByNumber]);

  const toggle = (clip: RadioClip) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playingId === clip.id) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    // One element for the list, re-pointed. Two clips can therefore never
    // overlap, and the previous one stops without any bookkeeping.
    audio.src = clip.url;
    audio
      .play()
      .then(() => setPlayingId(clip.id))
      .catch(() => setPlayingId(null));
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Clips" value={String(stats.total)} />
        <StatTile
          label="Drivers heard"
          value={String(stats.drivers)}
          hint={`of ${drivers.length} classified`}
        />
        <StatTile label="Total audio" value={`${stats.minutes.toFixed(1)} min`} />
        <StatTile
          label="Longest clip"
          value={formatClipDuration(stats.longest?.duration_s ?? null)}
          hint={
            stats.longest
              ? driverByNumber.get(stats.longest.driver_number)?.code ?? undefined
              : undefined
          }
        />
      </div>

      <div className="apex-glass-soft rounded-2xl p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
          <h3 className="font-[family-name:var(--font-headline)] font-bold text-xl">
            Team radio
          </h3>
          <label className="flex items-center gap-2 rounded-lg px-3 h-9 bg-white/[0.04] border border-white/[0.07] focus-within:border-flame-bright/50 transition-colors duration-150">
            <Search size={13} className="text-warm-500 flex-none" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search transcripts"
              aria-label="Search radio transcripts"
              className="bg-transparent outline-none font-semibold text-[12px] text-warm-100 placeholder:text-warm-500 w-[150px] md:w-[190px]"
            />
          </label>
        </div>

        {heard.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            <button
              onClick={() => setDriverFilter(null)}
              className={`font-bold text-[11px] uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors duration-150 ${
                driverFilter === null
                  ? "bg-primary-container/16 text-primary"
                  : "text-warm-500 hover:text-warm-300"
              }`}
            >
              All
            </button>
            {heard.map(({ number, count, driver }) => {
              const isActive = driverFilter === number;
              return (
                <button
                  key={number}
                  onClick={() => setDriverFilter(isActive ? null : number)}
                  className="font-bold text-[11px] uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors duration-150 flex items-center gap-1.5"
                  style={{
                    color: isActive ? driver?.teamColor ?? "var(--color-primary)" : undefined,
                    background: isActive ? `${driver?.teamColor ?? "#FF5A1F"}1f` : undefined,
                  }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: driver?.teamColor ?? "#6f665b" }}
                  />
                  <span className={isActive ? "" : "text-warm-400"}>
                    {driver?.code || `#${number}`}
                  </span>
                  <span className="text-warm-500 tabular-nums">{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {filtered.length === 0 ? (
          <p className="font-medium text-sm text-warm-400 py-10 text-center">
            {query.trim()
              ? `Nothing in this session's radio matches “${query.trim()}”.`
              : "No radio for this driver in this session."}
          </p>
        ) : (
          <div className="max-h-[560px] overflow-y-auto flex flex-col gap-2">
            {filtered.map((clip, index) => {
              const driver = driverByNumber.get(clip.driver_number);
              const colour = driver?.teamColor ?? "#FF5A1F";
              const isPlaying = playingId === clip.id;
              return (
                <motion.div
                  key={clip.id}
                  initial={reduce ? false : { opacity: 0, y: 8 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "0px 0px -40px 0px" }}
                  transition={{
                    duration: 0.35,
                    delay: reduce ? 0 : Math.min(index * 0.02, 0.3),
                    ease: EASE_OUT,
                  }}
                  className="flex items-start gap-3 rounded-xl px-4 py-3 border"
                  style={{
                    backgroundColor: "rgb(var(--rgb-veil) / 0.06)",
                    borderColor: `${colour}33`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggle(clip)}
                    aria-label={`${isPlaying ? "Pause" : "Play"} radio from ${
                      driver?.familyName || `car ${clip.driver_number}`
                    }`}
                    className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 transition-transform duration-150 active:scale-90"
                    style={{ backgroundColor: `${colour}1f`, border: `1px solid ${colour}4d` }}
                  >
                    {isPlaying ? (
                      <Pause className="w-3 h-3" style={{ color: colour }} />
                    ) : (
                      <Play className="w-3 h-3" style={{ color: colour }} />
                    )}
                  </button>

                  <div className="min-w-0 flex-1">
                    {clip.utterances.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        {clip.utterances.map((utterance, line) => {
                          const isDriver = utterance.speaker === "driver";
                          const isPit = utterance.speaker === "pit";
                          return (
                            <p key={line} className="flex gap-2 items-baseline">
                              <span
                                className="font-bold text-[9px] tracking-[0.1em] flex-none w-[34px] leading-[1.5]"
                                style={{ color: isDriver ? colour : "var(--color-warm-500)" }}
                              >
                                {isDriver ? driver?.code || "CAR" : isPit ? "PIT" : "RADIO"}
                              </span>
                              <span
                                className="font-medium text-[13px] leading-[1.5] min-w-0"
                                style={{
                                  color: isDriver
                                    ? "var(--color-warm-100)"
                                    : "var(--color-warm-300)",
                                }}
                              >
                                &ldquo;{utterance.text}&rdquo;
                              </span>
                            </p>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="font-medium text-[13px] text-warm-400 italic leading-snug">
                        No transcript — the clip is still playable.
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-warm-500">
                      <span className="flex items-center gap-1" style={{ color: colour }}>
                        <Radio size={10} />
                        {driver?.code || `#${clip.driver_number}`}
                      </span>
                      <span>{whenLabel(clip)}</span>
                      <span className="tabular-nums">{formatClock(clip.date)}</span>
                      <span className="tabular-nums">
                        {formatClipDuration(clip.duration_s)}
                      </span>
                      {clip.strong_language && <span>Explicit audio</span>}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}

        <p className="font-medium text-[11px] text-warm-500 mt-4 leading-relaxed">
          Transcripts are machine-generated from F1&apos;s published audio and
          are not an official record. Speaker labels are inferred — lines marked
          RADIO are ones we could not confidently attribute. Strong language is
          masked in the text; the audio is unedited.
        </p>
      </div>

      {/* One shared element for the list. `preload="none"` because a race can
          carry forty clips and preloading each would pull megabytes off F1's
          CDN for audio nobody asked to hear. */}
      <audio
        ref={audioRef}
        preload="none"
        onEnded={() => setPlayingId(null)}
        onPause={() => setPlayingId(null)}
      />
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Kicker, type WidgetProps } from "../widget-kit";

/**
 * The home page's window onto the 3D circuit viewer's Real world view.
 *
 * Real world (satellite photo on real terrain, with the buildings and woodland
 * around it) was a chip inside a page most visitors never opened. This puts a
 * looping clip of it on the front page, so the feature is seen before it is
 * hunted for.
 *
 * The clip is a screen capture of the real viewer, not a mock-up: see
 * `frontend/scripts/record-showcase.mjs` for how it is made and how to remake
 * it, which is worth doing whenever the scene's look changes.
 */
const CLIP = {
  circuit: "Monaco",
  href: "/circuits/monaco",
  video: "/showcase/real-world-monaco.mp4",
  poster: "/showcase/real-world-monaco.jpg",
};

const FEATURES = ["Satellite imagery", "True elevation", "Buildings & woodland"];

/**
 * The clip itself. It plays only while on screen and not at all for a visitor
 * who prefers reduced motion or has asked to save data: they get the still
 * frame, which is the same picture, and `preload="none"` means the video file
 * is not fetched until it is actually going to play.
 */
function Clip({ preview }: { preview?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || preview) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
      ?.saveData;
    if (reduceMotion || saveData) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.35 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [preview]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-card bg-black/40">
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- a 1280px still in the gallery picture
        <img src={CLIP.poster} alt="" className="h-full w-full object-cover" />
      ) : (
        <video
          ref={ref}
          className="h-full w-full object-cover"
          poster={CLIP.poster}
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
          tabIndex={-1}
        >
          <source src={CLIP.video} type="video/mp4" />
        </video>
      )}
      <span className="absolute left-3 bottom-3 apex-glass-soft rounded-lg px-2.5 py-1 font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-200">
        {CLIP.circuit} · Real world
      </span>
    </div>
  );
}

export function RealWorldWidget({ size, preview }: WidgetProps) {
  const full = size === "full";

  const copy = (
    <div className={`flex flex-col min-w-0 ${full ? "justify-center" : ""}`}>
      <Kicker>3D circuits</Kicker>
      <h2
        className={`font-[family-name:var(--font-headline)] font-extrabold tracking-[-0.5px] leading-[1.02] mt-2 ${
          full ? "text-[34px] lg:text-[40px]" : "text-[24px]"
        }`}
      >
        Fly the real circuit
      </h2>
      <p className={`font-medium text-warm-300 mt-3 ${full ? "text-[14px] max-w-md" : "text-[13px]"}`}>
        Satellite imagery, true terrain and the grandstands and buildings around it, rebuilt in 3D. Orbit it, scrub
        the elevation, or fly a lap.
      </p>
      <ul className="flex flex-wrap gap-2 mt-4">
        {FEATURES.map((feature) => (
          <li
            key={feature}
            className="apex-glass-soft rounded-lg px-2.5 py-1 font-semibold text-[11px] text-warm-200"
          >
            {feature}
          </li>
        ))}
      </ul>
      {!preview && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-5">
          <Link
            href={CLIP.href}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary-container px-4 py-2.5 font-semibold text-[13px] text-on-primary-container hover:brightness-110 transition-[filter,transform] duration-150 active:scale-[0.97]"
          >
            Open {CLIP.circuit} in 3D
            <span aria-hidden="true">→</span>
          </Link>
          <Link
            href="/circuits"
            className="font-semibold text-[13px] text-warm-300 hover:text-warm-100 transition-colors"
          >
            All circuits
          </Link>
        </div>
      )}
    </div>
  );

  return (
    <section
      aria-label="Real-world 3D circuits"
      className={`apex-glass apex-sheen rounded-panel overflow-hidden h-full ${
        full ? "grid gap-6 p-5 lg:p-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:items-center" : "flex flex-col gap-5 p-5"
      }`}
    >
      {copy}
      <Clip preview={preview} />
    </section>
  );
}

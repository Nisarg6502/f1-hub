"use client";

import dynamic from "next/dynamic";

/**
 * Client boundary for the WebGL viewer.
 *
 * `next/dynamic(..., { ssr: false })` is not permitted inside a Server Component
 * in the App Router, so the dynamic import has to live in a "use client" module
 * that the server page renders. Doing it directly in `page.tsx` fails the build
 * with an error that does not obviously point here.
 *
 * This is also what keeps ~300 KB of three/r3f out of every other route's bundle.
 */
const TrackViewer = dynamic(() => import("./track-viewer"), {
  ssr: false,
  loading: () => (
    <div className="flex flex-col gap-4">
      <div className="apex-glass-soft rounded-[22px] h-[clamp(360px,58vh,660px)] animate-pulse" />
      <div className="apex-glass-soft rounded-[18px] h-[76px] animate-pulse" />
      <div className="apex-glass-soft rounded-[18px] h-[300px] animate-pulse" />
    </div>
  ),
});

export default TrackViewer;

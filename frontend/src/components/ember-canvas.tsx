"use client";

import { useEffect, useRef } from "react";

/**
 * Warm ember particles drifting upward behind the hero — ported from the APEX
 * prototype. Purely decorative, so it bails out entirely when the user prefers
 * reduced motion.
 */
export default function EmberCanvas({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    let raf = 0;
    let w = 0;
    let h = 0;
    let ctx: CanvasRenderingContext2D | null = null;

    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = cv.getBoundingClientRect();
      cv.width = Math.max(1, r.width * dpr);
      cv.height = Math.max(1, r.height * dpr);
      const c = cv.getContext("2d");
      if (!c) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx = c;
      w = r.width;
      h = r.height;
    };

    type P = {
      x: number;
      y: number;
      r: number;
      sp: number;
      sw: number;
      amp: number;
      a: number;
    };
    const mk = (seed: boolean): P => ({
      x: Math.random() * w,
      y: seed ? Math.random() * h : h + 12,
      r: 1 + Math.random() * 2.4,
      sp: 0.25 + Math.random() * 0.95,
      sw: Math.random() * 6.28,
      amp: 4 + Math.random() * 10,
      a: 0.12 + Math.random() * 0.42,
    });

    fit();
    const ps = Array.from({ length: 60 }, () => mk(true));

    const loop = () => {
      const r = cv.getBoundingClientRect();
      if (Math.abs(r.width - w) > 2) fit();
      const c = ctx;
      if (!c) {
        raf = requestAnimationFrame(loop);
        return;
      }
      c.clearRect(0, 0, w, h);
      for (const p of ps) {
        p.y -= p.sp;
        p.sw += 0.016;
        const x = p.x + Math.sin(p.sw) * p.amp;
        const rad = p.r * 4;
        const g = c.createRadialGradient(x, p.y, 0, x, p.y, rad);
        g.addColorStop(0, `rgba(255,150,72,${p.a})`);
        g.addColorStop(0.5, `rgba(255,90,31,${p.a * 0.5})`);
        g.addColorStop(1, "rgba(255,90,31,0)");
        c.fillStyle = g;
        c.beginPath();
        c.arc(x, p.y, rad, 0, 6.29);
        c.fill();
        if (p.y < -24) Object.assign(p, mk(false), { x: Math.random() * w });
      }
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

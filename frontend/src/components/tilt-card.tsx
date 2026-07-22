"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

interface TiltCardProps {
  href?: string;
  className?: string;
  children: ReactNode;
  /** max rotation in degrees */
  strength?: number;
  /** show the moving specular glare highlight */
  glare?: boolean;
  glareSize?: number;
  ariaLabel?: string;
}

/**
 * A glass card that tilts toward the cursor in 3D with a moving specular
 * glare — the signature APEX interaction. Renders a <div>, or a Next <Link>
 * when `href` is provided. Motion is skipped for users who prefer reduced
 * motion (the CSS transition durations collapse via the global media query).
 */
export default function TiltCard({
  href,
  className = "",
  children,
  strength = 6,
  glare = true,
  glareSize = 220,
  ariaLabel,
}: TiltCardProps) {
  const onMove = (e: MouseEvent<HTMLElement>) => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    el.style.transform = `perspective(1000px) rotateX(${
      -(py - 0.5) * strength
    }deg) rotateY(${(px - 0.5) * strength}deg) translateY(-5px)`;
    el.style.setProperty("--mx", px * 100 + "%");
    el.style.setProperty("--my", py * 100 + "%");
    el.style.setProperty("--glare", "1");
  };

  const onLeave = (e: MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    el.style.transform = "";
    el.style.setProperty("--glare", "0");
  };

  const glareNode = glare ? (
    <div
      className="absolute inset-0 rounded-[inherit] pointer-events-none"
      style={{
        background: `radial-gradient(${glareSize}px circle at var(--mx,50%) var(--my,50%),rgba(255,255,255,0.16),transparent 60%)`,
        opacity: "var(--glare,0)",
        transition: "opacity 0.22s ease",
      }}
    />
  ) : null;

  const style = { transition: "transform 0.22s ease" } as const;

  if (href) {
    return (
      <Link
        href={href}
        aria-label={ariaLabel}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        className={className}
        style={style}
      >
        {glareNode}
        {children}
      </Link>
    );
  }

  return (
    <div
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={className}
      style={style}
    >
      {glareNode}
      {children}
    </div>
  );
}

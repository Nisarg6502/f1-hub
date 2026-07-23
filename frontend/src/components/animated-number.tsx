"use client";

import { useEffect, useRef } from "react";
import {
  useInView,
  useMotionValue,
  useSpring,
  useReducedMotion,
} from "motion/react";

/**
 * A number that springs up to its value the first time it scrolls into view —
 * the "number ticker" pattern. Keep the caller's font `tabular-nums` so the
 * width doesn't jitter while the digits roll. The initial DOM text is the final
 * value (SSR-correct, and what reduced-motion users keep); on mount in view we
 * reset to 0 and let the spring count up.
 */
export function AnimatedNumber({
  value,
  className,
  decimals = 0,
  format,
}: {
  value: number;
  className?: string;
  decimals?: number;
  /** custom formatter, e.g. thousands separators; overrides `decimals` */
  format?: (n: number) => string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -40px 0px" });
  const reduce = useReducedMotion();
  const mv = useMotionValue(value);
  const spring = useSpring(mv, { stiffness: 80, damping: 22, mass: 1 });

  const render = (n: number) =>
    format ? format(n) : n.toFixed(decimals);

  useEffect(() => {
    if (reduce) return;
    // Only kick off the count-up once the element is actually visible.
    if (inView) {
      mv.set(0);
      // next frame → animate to the real value
      const id = requestAnimationFrame(() => mv.set(value));
      return () => cancelAnimationFrame(id);
    }
  }, [inView, value, reduce, mv]);

  useEffect(() => {
    if (reduce) return;
    const unsub = spring.on("change", (v) => {
      if (ref.current) ref.current.textContent = render(v);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spring, reduce, decimals, format]);

  return (
    <span ref={ref} className={className}>
      {render(value)}
    </span>
  );
}

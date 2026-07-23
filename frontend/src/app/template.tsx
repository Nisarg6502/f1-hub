"use client";

import { motion, useReducedMotion } from "motion/react";

/**
 * Wraps every route's content and re-mounts on navigation, so each page fades
 * in on arrival — route changes feel connected instead of snapping.
 *
 * Deliberately opacity-only (no transform): a transformed ancestor becomes the
 * containing block for `position: sticky` descendants (e.g. the standings
 * sidebar), which would silently break them. A crossfade is safe and enough.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  if (reduce) return <>{children}</>;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
    >
      {children}
    </motion.div>
  );
}

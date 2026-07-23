"use client";

import {
  motion,
  useReducedMotion,
  type Variants,
  type HTMLMotionProps,
} from "motion/react";
import type { ReactNode } from "react";

/** Strong ease-out curve shared with the CSS `--ease-out-apex` token. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/**
 * A single block that fades + slides up as it scrolls into view. Replaces the
 * one-shot CSS `.anim-rise` for anything below the fold, so content animates
 * *when the user reaches it* instead of all at once on load.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 24,
  once = true,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  once?: boolean;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once, margin: "0px 0px -80px 0px" }}
      transition={{ duration: 0.55, delay, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Variant for a child inside <Stagger>. Export it so a client component can put
 * it on its own `motion.*` element (e.g. a `motion.button`) and still cascade
 * with the group, instead of wrapping in a plain <StaggerItem> div.
 */
export const revealItem: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: EASE_OUT },
  },
};

const itemVariants = revealItem;

/**
 * Stagger container: children marked with <StaggerItem> cascade in one after
 * another as the group enters the viewport. `gap` is the delay between items.
 */
export function Stagger({
  children,
  className,
  gap = 0.06,
  delayChildren = 0,
  once = true,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  gap?: number;
  delayChildren?: number;
  once?: boolean;
  as?: "div" | "ul";
}) {
  const reduce = useReducedMotion();
  const MotionTag = as === "ul" ? motion.ul : motion.div;
  return (
    <MotionTag
      className={className}
      initial={reduce ? false : "hidden"}
      whileInView="show"
      viewport={{ once, margin: "0px 0px -60px 0px" }}
      variants={{
        show: {
          transition: { staggerChildren: reduce ? 0 : gap, delayChildren },
        },
      }}
    >
      {children}
    </MotionTag>
  );
}

/** One item inside a <Stagger>. Cascades in with the group. */
export function StaggerItem({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & Omit<HTMLMotionProps<"div">, "children" | "className">) {
  return (
    <motion.div className={className} variants={itemVariants} {...rest}>
      {children}
    </motion.div>
  );
}

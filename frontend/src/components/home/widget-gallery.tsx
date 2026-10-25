"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useInView } from "motion/react";
import {
  WIDGET_CATALOGUE,
  WIDGET_TYPES,
  canAddWidget,
  type HomeLayout,
  type WidgetSize,
  type WidgetType,
} from "@/lib/home-layout";
import { useModalDialog } from "@/lib/use-modal-dialog";
import { SIZE_LABEL, WIDGET_REGISTRY } from "./registry";
import { WidgetBody } from "./widget-cell";
import type { HomeData } from "./home-data";

/**
 * Nominal widget footprints at the desktop grid's real metrics (4 columns of
 * ~325px, 252px rows, 20px gaps at a 1440px window). A preview renders the
 * widget at exactly this size and then zooms the whole box down to fit, so
 * what you see in the gallery is the widget as it will be laid out on a
 * laptop — not a thumbnail re-designed for the gallery.
 */
const NOMINAL_WIDTH: Record<WidgetSize, number> = { s: 325, m: 670, l: 670, full: 1360 };
const NOMINAL_HEIGHT: Record<WidgetSize, number | null> = { s: 252, m: 252, l: 524, full: null };
/** A large widget at full zoom is taller than most phone sheets. */
const MAX_PREVIEW_HEIGHT = 300;

function subscribeWide(cb: () => void) {
  const mq = window.matchMedia("(min-width: 768px)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const wideSnapshot = () => window.matchMedia("(min-width: 768px)").matches;

export default function WidgetGallery({
  open,
  layout,
  data,
  slots,
  reduce,
  onAdd,
  onClose,
}: {
  open: boolean;
  layout: HomeLayout;
  data: HomeData;
  slots: { raceWeek: ReactNode };
  reduce: boolean;
  onAdd: (type: WidgetType, size: WidgetSize) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return createPortal(
    <GallerySheet layout={layout} data={data} slots={slots} reduce={reduce} onAdd={onAdd} onClose={onClose} />,
    document.body
  );
}

/**
 * The "Add widget" sheet. A bottom sheet on a phone — it rises from the edge
 * the thumb is already at and leaves the page visible above it — and a
 * centred dialog from `md` up, where a sheet the width of a laptop would be
 * an awkward slab. Either way it is modal (`useModalDialog`: focus moves in,
 * Tab stays in, Escape closes, focus returns to "Add widget").
 *
 * Mounted only while open (the parent unmounts it on close) so its previews —
 * real widgets, one of which runs an ember canvas — cost nothing the rest of
 * the time. The exit is therefore not animated; dismissing is the frequent,
 * fast direction and an instant close is the honest one.
 */
function GallerySheet({
  layout,
  data,
  slots,
  reduce,
  onAdd,
  onClose,
}: {
  layout: HomeLayout;
  data: HomeData;
  slots: { raceWeek: ReactNode };
  reduce: boolean;
  onAdd: (type: WidgetType, size: WidgetSize) => void;
  onClose: () => void;
}) {
  const dialogRef = useModalDialog<HTMLDivElement>({ onClose });
  const wide = useSyncExternalStore(subscribeWide, wideSnapshot, () => true);

  const sheetMotion = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.15 } }
    : wide
      ? {
          initial: { opacity: 0, transform: "translateY(12px) scale(0.97)" },
          animate: { opacity: 1, transform: "translateY(0px) scale(1)" },
          transition: { type: "spring" as const, bounce: 0, duration: 0.32 },
        }
      : {
          // Drawer values from the apple-design table: a touch of bounce,
          // ~0.4s response. The sheet arrives with momentum it never had to
          // be dragged into, so the bounce is kept to a hint.
          initial: { transform: "translateY(100%)" },
          animate: { transform: "translateY(0%)" },
          transition: { type: "spring" as const, bounce: 0.12, duration: 0.42 },
        };

  return (
    <motion.div
      className="fixed inset-0 z-[80] flex items-end md:items-center justify-center md:p-10 bg-surface-container-lowest/65 backdrop-blur-[6px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="home-gallery-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        {...sheetMotion}
        className="relative w-full md:w-[760px] max-h-[88dvh] md:max-h-full overflow-y-auto overscroll-contain rounded-t-panel md:rounded-panel bg-surface-container-low/97 backdrop-blur-2xl border border-white/[0.1] pb-[max(1rem,env(safe-area-inset-bottom))] outline-none"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-4 px-5 md:px-7 pt-4 md:pt-6 pb-3 bg-surface-container-low/95 backdrop-blur-xl">
          {/* Grab bar: the visual promise of a sheet. Decorative — the sheet
              closes with the button, Escape or a tap outside, not a drag. */}
          <span aria-hidden="true" className="md:hidden absolute top-1.5 left-1/2 -translate-x-1/2 h-1 w-9 rounded-full bg-veil/20" />
          <div>
            <h2 id="home-gallery-title" className="font-[family-name:var(--font-headline)] font-bold text-xl">
              Add a widget
            </h2>
            <p className="font-medium text-xs text-warm-400 mt-0.5">Previews show live data at each size.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="relative w-10 h-10 rounded-full bg-veil/6 flex items-center justify-center text-warm-200 hover:bg-veil/12 active:scale-90 transition-[background-color,transform] duration-150 flex-none"
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              close
            </span>
          </button>
        </div>

        <ul className="px-5 md:px-7 pt-2 grid gap-4">
          {WIDGET_TYPES.map((type) => (
            <GalleryEntry
              key={type}
              type={type}
              available={canAddWidget(layout, type)}
              data={data}
              slots={slots}
              onAdd={onAdd}
            />
          ))}
        </ul>
      </motion.div>
    </motion.div>
  );
}

function GalleryEntry({
  type,
  available,
  data,
  slots,
  onAdd,
}: {
  type: WidgetType;
  available: boolean;
  data: HomeData;
  slots: { raceWeek: ReactNode };
  onAdd: (type: WidgetType, size: WidgetSize) => void;
}) {
  const spec = WIDGET_CATALOGUE[type];
  const def = WIDGET_REGISTRY[type];
  const [size, setSize] = useState<WidgetSize>(spec.defaultSize);
  const headingId = `gallery-${type}`;

  return (
    <li className="rounded-card apex-glass-soft p-4 md:p-5" aria-labelledby={headingId}>
      <div className="flex items-start gap-3">
        <span className="material-symbols-outlined text-[22px] text-flame mt-0.5 flex-none" aria-hidden="true">
          {def.icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="font-bold text-[15px]">
            {def.title}
          </h3>
          <p className="font-medium text-xs text-warm-400 mt-0.5">{def.description}</p>
        </div>
        <button
          type="button"
          disabled={!available}
          onClick={() => onAdd(type, size)}
          aria-label={available ? `Add ${def.title}, ${SIZE_LABEL[size].long}` : `${def.title} is already on your home`}
          className="relative flex-none h-10 px-4 rounded-full font-bold text-[13px] bg-primary-container text-[#1a1210] hover:brightness-110 active:scale-[0.96] transition-[filter,transform] duration-150 disabled:bg-veil/8 disabled:text-warm-400 disabled:pointer-events-none"
        >
          {available ? "Add" : "On your home"}
        </button>
      </div>

      {spec.sizes.length > 1 && (
        <div className="mt-3 inline-flex gap-1 p-1 rounded-full bg-veil/5" role="group" aria-label={`${def.title} size`}>
          {spec.sizes.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={s === size}
              onClick={() => setSize(s)}
              className={`relative h-8 min-w-10 px-3 rounded-full font-bold text-[12px] transition-colors duration-150 before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] ${
                s === size ? "bg-primary-container/25 text-primary" : "text-warm-300 hover:bg-veil/8"
              }`}
            >
              {SIZE_LABEL[s].long}
            </button>
          ))}
        </div>
      )}

      <Preview type={type} size={size} data={data} slots={slots} />
    </li>
  );
}

/**
 * A live preview, rendered only once its row scrolls near the viewport.
 *
 * Twelve real widgets at once would mean twelve sets of images and an ember
 * canvas the moment the sheet opens, most of them below the fold. Deferring
 * also means the constructors' table — the one preview that fetches — is only
 * requested if the visitor actually scrolls to it.
 *
 * Sized with CSS `zoom` rather than `transform: scale()`: zoom changes the
 * box's layout size too, so the frame is exactly as tall as the scaled widget
 * with no measuring of the widget itself — only of the space available.
 */
function Preview({
  type,
  size,
  data,
  slots,
}: {
  type: WidgetType;
  size: WidgetSize;
  data: HomeData;
  slots: { raceWeek: ReactNode };
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const inView = useInView(frameRef, { once: true, margin: "200px 0px" });
  const [available, setAvailable] = useState<number | null>(null);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const width = NOMINAL_WIDTH[size];
  const height = NOMINAL_HEIGHT[size];
  let zoom = available ? Math.min(1, available / width) : 0;
  if (height && zoom * height > MAX_PREVIEW_HEIGHT) zoom = MAX_PREVIEW_HEIGHT / height;

  return (
    <div ref={frameRef} className="mt-4 overflow-hidden rounded-tile" aria-hidden="true">
      {inView && available ? (
        <div
          inert
          className="pointer-events-none select-none"
          style={{ zoom, width, ...(height ? { height } : {}) }}
        >
          {/* The hero bleeds into the page gutter; give it one to bleed into. */}
          <div className={`relative ${height ? "h-full" : "px-10"}`}>
            <WidgetBody type={type} size={size} data={data} slots={slots} preview />
          </div>
        </div>
      ) : (
        <div className="rounded-tile bg-veil/[0.03]" style={{ height: Math.min(height ?? 160, MAX_PREVIEW_HEIGHT) * 0.6 }} />
      )}
    </div>
  );
}

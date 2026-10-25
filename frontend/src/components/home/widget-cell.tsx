"use client";

import { memo, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useSortable } from "@dnd-kit/sortable";
import { WIDGET_CATALOGUE, type HomeLayoutItem, type WidgetSize, type WidgetType } from "@/lib/home-layout";
import { EASE_OUT } from "@/components/motion-primitives";
import { SIZE_LABEL, WIDGET_REGISTRY } from "./registry";
import type { HomeData } from "./home-data";
import styles from "./home-grid.module.css";

/** How long a finger must rest on a widget before the home enters edit mode.
 * iOS's figure, near enough; long enough that a scroll that starts on a
 * widget never trips it, short enough not to feel like waiting. */
export const LONG_PRESS_MS = 500;
/** Movement that turns a press into a scroll and cancels the long-press. */
const LONG_PRESS_SLOP_PX = 10;

export const SIZE_CLASS: Record<WidgetSize, string> = {
  s: styles["size-s"],
  m: styles["size-m"],
  l: styles["size-l"],
  full: styles["size-full"],
};

/**
 * One widget's body. Memoised on purpose and kept separate from the cell:
 * dnd-kit re-renders every `useSortable` consumer on each pointer move of a
 * drag, and the cell is cheap to re-render while a widget (an ember canvas,
 * a ticking countdown, a standings table) is not. `data` and `slots` are the
 * page's props and never change identity, so this only re-renders when the
 * widget's own type, size or edit state does.
 */
export const WidgetBody = memo(function WidgetBody({
  type,
  size,
  data,
  slots,
  editing,
  preview,
}: {
  type: WidgetType;
  size: WidgetSize;
  data: HomeData;
  slots: { raceWeek: ReactNode };
  editing?: boolean;
  preview?: boolean;
}) {
  const { Component } = WIDGET_REGISTRY[type];
  return <Component data={data} size={size} slots={slots} editing={editing} preview={preview} />;
});

export interface WidgetCellProps {
  item: HomeLayoutItem;
  index: number;
  count: number;
  data: HomeData;
  slots: { raceWeek: ReactNode };
  editing: boolean;
  selected: boolean;
  /** This cell is the drag source; the overlay is drawing the widget. */
  placeholder: boolean;
  /** Changes whenever any item moves, resizes, arrives or leaves — the only
   * times a cell needs to measure itself for a layout animation. */
  layoutKey: string;
  layoutTransition: Transition;
  /** Position in the run of small widgets it belongs to, for the entrance
   * cascade the old bento row had. Null: no entrance animation. */
  revealOrder: number | null;
  reduce: boolean;
  instructionsId: string;
  onSelect: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, item: HomeLayoutItem) => void;
  onLongPress: (id: string) => void;
  onRemove: (item: HomeLayoutItem) => void;
  onResize: (item: HomeLayoutItem, size: WidgetSize) => void;
  onMove: (item: HomeLayoutItem, delta: number) => void;
}

export function WidgetCell(props: WidgetCellProps) {
  const {
    item,
    index,
    count,
    data,
    slots,
    editing,
    selected,
    placeholder,
    layoutKey,
    layoutTransition,
    revealOrder,
    reduce,
    instructionsId,
    onSelect,
    onKeyDown,
    onLongPress,
    onRemove,
    onResize,
    onMove,
  } = props;
  const { title } = WIDGET_REGISTRY[item.type];
  const { setNodeRef, listeners } = useSortable({ id: item.id, disabled: !editing });

  /* --------------------------- long-press to edit --------------------------- */
  // Touch only: a mouse has right-click and the Edit button, and a 500ms
  // mouse hold is how people select text. The timer is cancelled by movement
  // past the slop (that was a scroll) and by `pointercancel`, which the
  // browser fires the moment it takes the gesture over for panning.
  const press = useRef<{ x: number; y: number; timer: number; fired: boolean } | null>(null);
  const clearPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };

  const pressHandlers = editing
    ? {}
    : {
        onPointerDown: (e: React.PointerEvent) => {
          if (e.pointerType !== "touch") return;
          clearPress();
          const timer = window.setTimeout(() => {
            if (press.current) press.current.fired = true;
            navigator.vibrate?.(8);
            onLongPress(item.id);
          }, LONG_PRESS_MS);
          press.current = { x: e.clientX, y: e.clientY, timer, fired: false };
        },
        onPointerMove: (e: React.PointerEvent) => {
          const p = press.current;
          if (!p || p.fired) return;
          if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP_PX) {
            clearPress();
            press.current = null;
          }
        },
        onPointerUp: clearPress,
        onPointerCancel: () => {
          clearPress();
          press.current = null;
        },
        // The finger lifting after a long-press is a click on whatever link
        // the widget is; that click must not navigate away from the editor
        // it just opened.
        onClickCapture: (e: React.MouseEvent) => {
          if (press.current?.fired) {
            e.preventDefault();
            e.stopPropagation();
            press.current = null;
          }
        },
        // Android raises the context menu (and starts a text selection) at
        // about the same moment the long-press fires.
        onContextMenu: (e: React.MouseEvent) => {
          if (press.current) e.preventDefault();
        },
      };

  const jiggleStyle = { "--jiggle-delay": `${-((index * 97) % 280)}ms` } as CSSProperties;

  return (
    <motion.div
      ref={setNodeRef}
      data-widget-cell={item.id}
      layout="position"
      layoutDependency={layoutKey}
      transition={{ layout: layoutTransition }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={
        reduce
          ? { opacity: 0, transition: { duration: 0.12 } }
          : { opacity: 0, scale: 0.92, transition: { duration: 0.16, ease: EASE_OUT } }
      }
      className={`@container relative ${SIZE_CLASS[item.size]} [-webkit-touch-callout:none] ${
        editing
          ? "rounded-panel outline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary touch-manipulation cursor-grab active:cursor-grabbing"
          : ""
      }`}
      tabIndex={editing ? 0 : undefined}
      role={editing ? "group" : undefined}
      aria-roledescription={editing ? "widget" : undefined}
      aria-label={editing ? `${title}, ${SIZE_LABEL[item.size].long}, ${index + 1} of ${count}` : undefined}
      aria-describedby={editing ? instructionsId : undefined}
      onKeyDown={editing ? (e: KeyboardEvent<HTMLDivElement>) => onKeyDown(e, item) : undefined}
      onFocus={editing ? () => onSelect(item.id) : undefined}
      onPointerDownCapture={editing ? () => onSelect(item.id) : undefined}
      {...(editing ? listeners : {})}
      {...pressHandlers}
    >
      <div
        className={`h-full ${editing ? styles.jiggle : ""} ${editing && (selected || placeholder) ? styles.still : ""}`}
        style={editing ? jiggleStyle : undefined}
      >
        {/* `inert` while editing: a widget being arranged is a picture of
            itself. Its links must not navigate when it is tapped to select
            it, and its buttons must not sit in the tab order between the
            editor's own controls. */}
        <div
          inert={editing}
          className={`h-full ${editing ? "pointer-events-none select-none" : ""} ${
            placeholder ? "invisible" : ""
          }`}
        >
          <Reveal order={revealOrder} reduce={reduce} sizeKey={item.size}>
            <WidgetBody type={item.type} size={item.size} data={data} slots={slots} editing={editing} />
          </Reveal>
        </div>

        {placeholder && (
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-panel border-2 border-dashed border-primary-container/35 bg-primary-container/[0.04]"
          />
        )}

        {editing && !placeholder && (
          <EditChrome
            item={item}
            index={index}
            count={count}
            title={title}
            showToolbar={selected}
            reduce={reduce}
            onRemove={onRemove}
            onResize={onResize}
            onMove={onMove}
          />
        )}
      </div>
    </motion.div>
  );
}

/**
 * Two jobs. First, the entrance cascade the old bento row had (`Stagger` /
 * `StaggerItem`), reproduced per cell because the cards are no longer
 * siblings in one stagger group. Second, a short crossfade when the size
 * changes: the cell snaps to its new shape (animating a size change with a
 * transform would squash the text inside it) and the new composition fades
 * up over the old footprint, which is how iOS does it too.
 */
function Reveal({
  order,
  reduce,
  sizeKey,
  children,
}: {
  order: number | null;
  reduce: boolean;
  sizeKey: WidgetSize;
  children: ReactNode;
}) {
  const enter = order !== null && !reduce;
  return (
    <motion.div
      key={sizeKey}
      className="h-full"
      initial={enter ? { opacity: 0, y: 18 } : false}
      whileInView={enter ? { opacity: 1, y: 0 } : undefined}
      viewport={{ once: true, margin: "0px 0px -60px 0px" }}
      transition={{ duration: 0.5, ease: EASE_OUT, delay: enter ? Math.min(order!, 4) * 0.08 : 0 }}
    >
      {children}
    </motion.div>
  );
}

/* --------------------------------- edit chrome --------------------------------- */

/** Every control here is 40px to a finger, whatever its visual size — the
 * `before:` pseudo-element pattern from the ring info button on this page. */
const CHROME_BTN =
  "relative flex items-center justify-center h-8 w-10 rounded-full text-warm-100 transition-[background-color,transform,color] duration-150 hover:bg-veil/10 active:scale-[0.94] disabled:opacity-35 disabled:pointer-events-none before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";

function EditChrome({
  item,
  index,
  count,
  title,
  showToolbar,
  reduce,
  onRemove,
  onResize,
  onMove,
}: {
  item: HomeLayoutItem;
  index: number;
  count: number;
  title: string;
  showToolbar: boolean;
  reduce: boolean;
  onRemove: (item: HomeLayoutItem) => void;
  onResize: (item: HomeLayoutItem, size: WidgetSize) => void;
  onMove: (item: HomeLayoutItem, delta: number) => void;
}) {
  const sizes = WIDGET_CATALOGUE[item.type].sizes;
  const nextSize = sizes[(sizes.indexOf(item.size) + 1) % sizes.length];
  // The chrome is part of the cell, so a press on it would otherwise reach
  // dnd-kit's listeners on the cell and could start a drag.
  const stop = {
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
  };
  const pop = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, transform: "scale(0.9)" },
        animate: { opacity: 1, transform: "scale(1)" },
        exit: { opacity: 0, transform: "scale(0.94)" },
      };

  return (
    <>
      <motion.button
        type="button"
        {...pop}
        transition={{ duration: 0.16, ease: EASE_OUT }}
        {...stop}
        onClick={() => onRemove(item)}
        aria-label={`Remove ${title}`}
        className="absolute -top-2.5 -left-2.5 z-20 w-7 h-7 rounded-full apex-glass-strong flex items-center justify-center text-warm-100 hover:text-white active:scale-90 transition-transform duration-150 before:absolute before:-inset-1.5 before:content-[''] outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        style={{ position: "absolute" }}
      >
        <span className="material-symbols-outlined text-[18px] leading-none" aria-hidden="true">
          remove
        </span>
      </motion.button>

      {/* Centred by a static flex row rather than a translate, because the
          pop animation owns the toolbar's `transform`. */}
      <div className="absolute z-20 bottom-3 inset-x-0 flex justify-center pointer-events-none">
      <AnimatePresence>
        {showToolbar && (
          <motion.div
            key="toolbar"
            {...pop}
            transition={{ duration: 0.16, ease: EASE_OUT }}
            {...stop}
            role="toolbar"
            aria-label={`${title} options`}
            className="pointer-events-auto flex items-center gap-0.5 p-1 rounded-full apex-glass-strong cursor-default"
            style={{ transformOrigin: "50% 100%" }}
          >
            <button
              type="button"
              className={CHROME_BTN}
              disabled={index === 0}
              onClick={() => onMove(item, -1)}
              aria-label={`Move ${title} earlier`}
            >
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                chevron_left
              </span>
            </button>

            {sizes.length > 1 && (
              <>
                {/* Wide cells get every size as a segmented control; a 1×1 on
                    a phone is ~170px wide, which fits the two move buttons and
                    one more — so there it is a single "next size" button. */}
                <div className="hidden @min-[260px]:flex items-center gap-0.5" role="group" aria-label="Size">
                  {sizes.map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={s === item.size}
                      aria-label={SIZE_LABEL[s].long}
                      onClick={() => onResize(item, s)}
                      className={`${CHROME_BTN} font-bold text-[12px] ${
                        s === item.size ? "bg-primary-container/25 text-primary hover:bg-primary-container/30" : ""
                      }`}
                    >
                      {SIZE_LABEL[s].short}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className={`${CHROME_BTN} @min-[260px]:hidden font-bold text-[12px] gap-0.5 bg-primary-container/20 text-primary`}
                  onClick={() => onResize(item, nextSize)}
                  aria-label={`Size: ${SIZE_LABEL[item.size].long}. Change to ${SIZE_LABEL[nextSize].long}`}
                >
                  {SIZE_LABEL[item.size].short}
                  <span className="material-symbols-outlined text-[14px] leading-none" aria-hidden="true">
                    unfold_more
                  </span>
                </button>
              </>
            )}

            <button
              type="button"
              className={CHROME_BTN}
              disabled={index === count - 1}
              onClick={() => onMove(item, 1)}
              aria-label={`Move ${title} later`}
            >
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                chevron_right
              </span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </>
  );
}

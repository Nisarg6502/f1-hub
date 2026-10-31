"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { SortableContext, arrayMove } from "@dnd-kit/sortable";
import {
  DEFAULT_HOME_LAYOUT,
  addWidget,
  commitHomeLayout,
  homeLayoutServerSnapshot,
  homeLayoutSnapshot,
  isDefaultLayout,
  moveWidget,
  moveWidgetBy,
  nextWidgetId,
  removeWidget,
  resizeWidget,
  stepSize,
  subscribeHomeLayout,
  type HomeLayout,
  type HomeLayoutItem,
  type WidgetSize,
  type WidgetType,
} from "@/lib/home-layout";
import { EASE_OUT } from "@/components/motion-primitives";
import { SIZE_LABEL, WIDGET_REGISTRY } from "./registry";
import { SIZE_CLASS, WidgetBody, WidgetCell } from "./widget-cell";
import WidgetGallery from "./widget-gallery";
import type { HomeData } from "./home-data";
import styles from "./home-grid.module.css";

/**
 * The customisable home: a grid of widgets the visitor can rearrange, resize,
 * add and remove.
 *
 * ## Server default, client layout
 *
 * The server always renders the *default* layout (`homeLayoutServerSnapshot`),
 * with every default widget's data already fetched — so a visitor who never
 * customises gets exactly the old page: no extra requests, no skeletons, no
 * shift. The stored layout lives in `localStorage`, which the server cannot
 * see, so a customised visitor necessarily sees the default first.
 *
 * The swap is made calm rather than avoided. After hydration, if the stored
 * layout differs, the grid fades out (160ms), the stored layout replaces the
 * default while it is invisible, and it fades back in. The alternatives were
 * worse: swapping instantly is a visible jump of every widget; a blocking
 * inline script that hides the grid until storage is read makes *every*
 * visitor — including the default majority — wait on JavaScript to see the
 * hero; and a cookie that let the server render the custom layout would make
 * the page per-visitor uncacheable and is exactly the job the coming accounts
 * system will do properly behind `HomeLayoutStorage`. The cost accepted here
 * is a ~400ms fade-through, once per page load, for customised visitors only.
 *
 * ## Editing
 *
 * Enter from the "Edit home" button or a long-press on any widget (touch).
 * Widgets jiggle, gain a remove badge, and the selected one shows a toolbar
 * (move earlier/later, size). Drag reorders: dnd-kit tracks the pointer and
 * draws the dragged widget in a `DragOverlay`; the underlying list is
 * re-ordered live as it passes over others, and motion's layout animation
 * springs everything else aside. Every action is also a key on the focused
 * widget and is announced through a live region.
 */

/** Critically damped, ~0.35s: widgets moving out of the way of a drag are a
 * reposition, not a throw, so they settle without overshoot. */
const LAYOUT_SPRING: Transition = { type: "spring", bounce: 0, duration: 0.35 };
/** Keyboard moves are instant. A keyboard action repeated ten times in a row
 * must not queue up ten animations; focus follows the widget and the
 * announcement says where it went. */
const INSTANT: Transition = { duration: 0 };

const DROP_ANIMATION: DropAnimation = {
  duration: 220,
  easing: "cubic-bezier(0.23, 1, 0.32, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
};

/** Over a widget under the pointer if there is one; otherwise the nearest.
 * Pointer-first because widgets differ in size, and "the one under my
 * finger" is what a person means — the nearest *centre* to a dragged 1×1
 * can be a neighbour of the 2×2 it is visibly over. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

function title(type: WidgetType) {
  return WIDGET_REGISTRY[type].title;
}

export default function HomeGrid({ data, raceWeek }: { data: HomeData; raceWeek: ReactNode }) {
  const reduce = useReducedMotion() ?? false;
  const slots = useMemo(() => ({ raceWeek }), [raceWeek]);
  const instructionsId = useId();

  /* ------------------------------- the layout ------------------------------- */

  const stored = useSyncExternalStore(subscribeHomeLayout, homeLayoutSnapshot, homeLayoutServerSnapshot);
  // False until the client has taken over from the server-rendered default.
  // See "Server default, client layout" above.
  const [takenOver, setTakenOver] = useState(false);
  const fadingOut = !takenOver && stored !== DEFAULT_HOME_LAYOUT;
  const layout = takenOver ? stored : DEFAULT_HOME_LAYOUT;

  // Belt and braces for the fade: if the opacity animation never reports
  // completion (a background tab can starve it of frames), take over anyway.
  useEffect(() => {
    if (!fadingOut) return;
    const t = window.setTimeout(() => setTakenOver(true), 600);
    return () => window.clearTimeout(t);
  }, [fadingOut]);

  /* ------------------------------ editor state ------------------------------ */

  const [editing, setEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [undoLayout, setUndoLayout] = useState<HomeLayout | null>(null);
  const [moveSource, setMoveSource] = useState<"pointer" | "keyboard">("pointer");
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  // Live drag preview: the list re-ordered as the dragged widget passes over
  // others. Committed on drop, discarded on cancel.
  const [dragItems, setDragItems] = useState<HomeLayoutItem[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const pendingFocus = useRef<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  const announce = useCallback((text: string) => {
    // The counter makes a repeated identical message ("moved to position 2")
    // a new text node, so screen readers announce it again.
    setAnnouncement((prev) => ({ text, n: prev.n + 1 }));
  }, []);

  /** Every edit goes through here: the client owns the layout from the first
   * edit on, and any edit other than a reset retires the reset's undo. */
  const apply = useCallback((next: HomeLayout, opts: { keepUndo?: boolean } = {}) => {
    setTakenOver(true);
    if (!opts.keepUndo) setUndoLayout(null);
    commitHomeLayout(next);
  }, []);

  // Focus follows the widget an action was taken on. In an effect because
  // the element it should land on may not exist until this render commits.
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    if (id === "__edit-button__") {
      editButtonRef.current?.focus({ preventScroll: true });
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-widget-cell="${CSS.escape(id)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }
  });

  const startEditing = useCallback(
    (opts: { focusFirst?: boolean; selectId?: string } = {}) => {
      setEditing(true);
      setSelectedId(opts.selectId ?? null);
      announce(
        "Editing home. Drag widgets to rearrange them, or focus one and use the arrow keys. Plus and minus change its size, Delete removes it, Escape finishes."
      );
      if (opts.focusFirst && layout.items[0]) pendingFocus.current = layout.items[0].id;
    },
    [announce, layout.items]
  );

  const finishEditing = useCallback(() => {
    setEditing(false);
    setSelectedId(null);
    setGalleryOpen(false);
    setUndoLayout(null);
    announce("Finished editing home.");
    pendingFocus.current = "__edit-button__";
  }, [announce]);

  // Escape finishes editing from anywhere — except while the gallery is
  // open, where the dialog's own Escape closes the gallery first.
  useEffect(() => {
    if (!editing || galleryOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") finishEditing();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, galleryOpen, finishEditing]);

  /* --------------------------------- actions --------------------------------- */

  const move = useCallback(
    (item: HomeLayoutItem, delta: number, source: "pointer" | "keyboard") => {
      const next = moveWidgetBy(layout, item.id, delta);
      if (next === layout) return;
      setMoveSource(source);
      apply(next);
      const to = next.items.findIndex((i) => i.id === item.id);
      announce(`${title(item.type)} moved to position ${to + 1} of ${next.items.length}.`);
      if (source === "keyboard") pendingFocus.current = item.id;
    },
    [layout, apply, announce]
  );

  const moveTo = useCallback(
    (item: HomeLayoutItem, to: number) => {
      const from = layout.items.findIndex((i) => i.id === item.id);
      const next = moveWidget(layout, from, to);
      if (next === layout) return;
      setMoveSource("keyboard");
      apply(next);
      const at = next.items.findIndex((i) => i.id === item.id);
      announce(`${title(item.type)} moved to position ${at + 1} of ${next.items.length}.`);
      pendingFocus.current = item.id;
    },
    [layout, apply, announce]
  );

  const resize = useCallback(
    (item: HomeLayoutItem, size: WidgetSize) => {
      const next = resizeWidget(layout, item.id, size);
      if (next === layout) return;
      setMoveSource("pointer");
      apply(next);
      announce(`${title(item.type)} is now ${SIZE_LABEL[size].long.toLowerCase()}.`);
    },
    [layout, apply, announce]
  );

  const remove = useCallback(
    (item: HomeLayoutItem) => {
      const index = layout.items.findIndex((i) => i.id === item.id);
      const next = removeWidget(layout, item.id);
      if (next === layout) return;
      setMoveSource("pointer");
      apply(next);
      announce(`Removed ${title(item.type)}. You can add it back from Add widget.`);
      // Focus the widget that took its place, else the one before, else the
      // Add button — never drop focus onto <body>.
      const neighbour = next.items[index] ?? next.items[index - 1];
      pendingFocus.current = neighbour ? neighbour.id : null;
      if (!neighbour) document.getElementById("home-add-widget")?.focus();
    },
    [layout, apply, announce]
  );

  const add = useCallback(
    (type: WidgetType, size: WidgetSize) => {
      const id = nextWidgetId(layout, type);
      const next = addWidget(layout, type, size);
      if (next === layout) return;
      setGalleryOpen(false);
      setMoveSource("pointer");
      apply(next);
      announce(`Added ${title(type)} at the end of your home.`);
      pendingFocus.current = id;
      setSelectedId(id);
    },
    [layout, apply, announce]
  );

  const reset = useCallback(() => {
    if (isDefaultLayout(layout)) return;
    setUndoLayout(layout);
    setMoveSource("pointer");
    apply(DEFAULT_HOME_LAYOUT, { keepUndo: true });
    announce("Home reset to the default layout. Undo is available.");
  }, [layout, apply, announce]);

  const undoReset = useCallback(() => {
    if (!undoLayout) return;
    apply(undoLayout);
    announce("Reset undone.");
  }, [undoLayout, apply, announce]);

  const onCellKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, item: HomeLayoutItem) => {
      // Only keys aimed at the widget itself; the toolbar's buttons handle
      // their own (and stop propagation).
      if (e.target !== e.currentTarget) return;
      const last = layout.items.length - 1;
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowUp":
          move(item, -1, "keyboard");
          break;
        case "ArrowRight":
        case "ArrowDown":
          move(item, 1, "keyboard");
          break;
        case "Home":
          moveTo(item, 0);
          break;
        case "End":
          moveTo(item, last);
          break;
        case "+":
        case "=": {
          const s = stepSize(item.type, item.size, 1);
          if (s) resize(item, s);
          else announce(`${title(item.type)} is already at its largest size.`);
          break;
        }
        case "-":
        case "_": {
          const s = stepSize(item.type, item.size, -1);
          if (s) resize(item, s);
          else announce(`${title(item.type)} is already at its smallest size.`);
          break;
        }
        case "Delete":
        case "Backspace":
          remove(item);
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    [layout.items.length, move, moveTo, resize, remove, announce]
  );

  /* ------------------------------------ drag ------------------------------------ */

  const sensors = useSensors(
    // A few pixels of travel before a mouse drag starts, so a click selects.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // A short hold before a touch drag starts, so a swipe that begins on a
    // widget still scrolls the page while editing.
    useSensor(TouchSensor, { activationConstraint: { delay: 160, tolerance: 8 } })
  );

  const onDragStart = useCallback(({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    setSelectedId(String(active.id));
    setDragItems([...layout.items]);
    setMoveSource("pointer");
  }, [layout.items]);

  const onDragOver = useCallback(({ active, over }: DragOverEvent) => {
    if (!over || active.id === over.id) return;
    setDragItems((items) => {
      if (!items) return items;
      const from = items.findIndex((i) => i.id === active.id);
      const to = items.findIndex((i) => i.id === over.id);
      return from < 0 || to < 0 ? items : arrayMove(items, from, to);
    });
  }, []);

  const onDragEnd = useCallback(
    ({ active }: DragEndEvent) => {
      const from = layout.items.findIndex((i) => i.id === active.id);
      const to = dragItems?.findIndex((i) => i.id === active.id) ?? -1;
      setActiveId(null);
      setDragItems(null);
      if (from < 0 || to < 0 || from === to) return;
      const next = moveWidget(layout, from, to);
      apply(next);
    },
    [layout, dragItems, apply]
  );

  const onDragCancel = useCallback(() => {
    setActiveId(null);
    setDragItems(null);
  }, []);

  const announcements: Announcements = useMemo(() => {
    const name = (id: string | number) => {
      const item = layout.items.find((i) => i.id === id);
      return item ? title(item.type) : "widget";
    };
    return {
      onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
      onDragOver: ({ active, over }) => (over && over.id !== active.id ? `${name(active.id)} is over ${name(over.id)}.` : undefined),
      onDragEnd: ({ active }) => {
        const at = (dragItems ?? layout.items).findIndex((i) => i.id === active.id);
        return `${name(active.id)} dropped at position ${at + 1} of ${layout.items.length}.`;
      },
      onDragCancel: ({ active }) => `Moving ${name(active.id)} was cancelled.`,
    };
  }, [layout.items, dragItems]);

  /* ----------------------------------- render ----------------------------------- */

  const items = dragItems ?? layout.items;
  const visible = editing ? items : items.filter((i) => !WIDGET_REGISTRY[i.type].isEmpty?.(data));
  const layoutKey = items.map((i) => `${i.id}:${i.size}`).join("|");
  const activeItem = activeId ? items.find((i) => i.id === activeId) ?? null : null;

  // Small widgets in a run cascade in one after another, like the old bento
  // row did; a full-width widget ends the run.
  const revealOrders: (number | null)[] = [];
  let run = 0;
  for (const item of visible) {
    if (item.size === "full") {
      run = 0;
      revealOrders.push(null);
    } else {
      revealOrders.push(run);
      run += 1;
    }
  }

  return (
    <div className="px-6 md:px-10">
      {/* Read by a screen reader when a widget takes focus in edit mode. */}
      <p id={instructionsId} className="sr-only">
        Arrow keys move this widget. Home and End move it to the start or end. Plus and minus change its size.
        Delete removes it. Escape finishes editing.
      </p>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        <span key={announcement.n}>{announcement.text}</span>
      </div>

      <motion.div
        initial={false}
        animate={{ opacity: fadingOut ? 0 : 1 }}
        transition={{ duration: fadingOut ? 0.16 : 0.24, ease: EASE_OUT }}
        onAnimationComplete={() => {
          if (fadingOut) setTakenOver(true);
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          // Re-measure after every live re-order. dnd-kit measures droppables
          // without their transforms by default, so a widget mid-way through
          // its layout spring is hit-tested where it is going, not where it
          // happens to be drawn — otherwise a moving neighbour could slide
          // under the pointer, trigger another swap, and oscillate.
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          accessibility={{ announcements, screenReaderInstructions: { draggable: "" } }}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          {/* No sorting strategy: dnd-kit's strategies move neighbours with
              transforms sized for equal items and would stretch a 1×1 into a
              2×2's slot. The list itself is re-ordered instead, and motion
              animates the real layout. */}
          <SortableContext items={visible.map((i) => i.id)} strategy={() => null}>
            <div className={`${styles.grid} pb-0`}>
              <AnimatePresence initial={false} mode="popLayout">
                {visible.map((item, index) => (
                  <WidgetCell
                    key={item.id}
                    item={item}
                    index={index}
                    count={visible.length}
                    data={data}
                    slots={slots}
                    editing={editing}
                    selected={selectedId === item.id}
                    placeholder={activeId === item.id}
                    layoutKey={layoutKey}
                    layoutTransition={moveSource === "keyboard" || reduce ? INSTANT : LAYOUT_SPRING}
                    revealOrder={revealOrders[index]}
                    reduce={reduce}
                    instructionsId={instructionsId}
                    onSelect={setSelectedId}
                    onKeyDown={onCellKeyDown}
                    onLongPress={(id) => startEditing({ selectId: id })}
                    onRemove={remove}
                    onResize={resize}
                    onMove={(it, d) => move(it, d, "pointer")}
                  />
                ))}
              </AnimatePresence>
              {visible.length === 0 && (
                <div className="col-span-full rounded-panel border border-dashed border-veil/15 px-6 py-12 text-center">
                  <p className="font-[family-name:var(--font-headline)] font-bold text-lg">Your home is empty</p>
                  <p className="font-medium text-sm text-warm-400 mt-1">Add widgets back, or reset to the default.</p>
                </div>
              )}
            </div>
          </SortableContext>

          <DragOverlay dropAnimation={reduce ? null : DROP_ANIMATION}>
            {activeItem ? (
              /* Lifted: a little larger and casting a deeper shadow, so the
                 widget in hand reads as above the grid rather than in it. */
              <motion.div
                className={`${SIZE_CLASS[activeItem.size]} !h-full rounded-panel shadow-[0_30px_80px_rgba(0,0,0,0.55)] cursor-grabbing`}
                initial={{ transform: "scale(1)" }}
                animate={{ transform: reduce ? "scale(1)" : "scale(1.03)" }}
                transition={{ type: "spring", bounce: 0, duration: 0.25 }}
              >
                <div inert className="h-full pointer-events-none select-none">
                  <WidgetBody type={activeItem.type} size={activeItem.size} data={data} slots={slots} editing />
                </div>
              </motion.div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </motion.div>

      {/* "Edit home" sits after the last widget rather than in the hero, so
          the default page above the fold is exactly the old one. */}
      <div className="flex justify-end pt-6 pb-12 lg:pb-14">
        {!editing && (
          <button
            ref={editButtonRef}
            type="button"
            onClick={() => startEditing({ focusFirst: true })}
            className="relative inline-flex items-center gap-2 h-10 px-4 rounded-full apex-glass-soft font-semibold text-[13px] text-warm-200 hover:text-white active:scale-[0.97] transition-[transform,color] duration-150 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              dashboard_customize
            </span>
            Edit home
          </button>
        )}
      </div>

      <AnimatePresence>
        {editing && (
          <EditBar
            reduce={reduce}
            canReset={!isDefaultLayout(layout)}
            canUndo={undoLayout !== null}
            onAdd={() => setGalleryOpen(true)}
            onReset={reset}
            onUndo={undoReset}
            onDone={finishEditing}
          />
        )}
      </AnimatePresence>

      <WidgetGallery
        open={galleryOpen}
        layout={layout}
        data={data}
        slots={slots}
        reduce={reduce}
        onAdd={add}
        onClose={() => setGalleryOpen(false)}
      />
    </div>
  );
}

/**
 * The floating editor controls. Bottom-centre, because that is where a thumb
 * is on a phone and where it stays out of the content's way on a laptop;
 * lifted above the mobile tab strip below `lg`.
 *
 * Reset is reversible instead of confirmed: a confirmation dialog for a layout
 * is friction on the common case to guard the rare one, whereas Undo costs the
 * person who meant it nothing and rescues the one who didn't.
 */
function EditBar({
  reduce,
  canReset,
  canUndo,
  onAdd,
  onReset,
  onUndo,
  onDone,
}: {
  reduce: boolean;
  canReset: boolean;
  canUndo: boolean;
  onAdd: () => void;
  onReset: () => void;
  onUndo: () => void;
  onDone: () => void;
}) {
  const btn =
    "relative inline-flex items-center gap-1.5 h-10 px-4 rounded-full font-semibold text-[13px] whitespace-nowrap transition-[background-color,transform,color] duration-150 active:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";
  return (
    <motion.div
      role="toolbar"
      aria-label="Edit home"
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(16px)" }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, transform: "translateY(0px)" }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(12px)", transition: { duration: 0.15 } }}
      transition={{ type: "spring", bounce: 0, duration: 0.3 }}
      // Centred with auto margins, not a translate: the enter animation owns
      // `transform`. Below `lg` it clears both the tab strip and the
      // assistant's floating button, which sits just above the strip on the
      // right and covered "Done" at 88px.
      className="fixed z-[55] inset-x-0 mx-auto w-fit bottom-[calc(150px+env(safe-area-inset-bottom))] lg:bottom-6 flex items-center gap-1 p-1.5 rounded-full apex-glass-strong max-w-[calc(100vw-24px)]"
      style={{ position: "fixed" }}
    >
      <button id="home-add-widget" type="button" onClick={onAdd} className={`${btn} text-warm-100 hover:bg-veil/10`}>
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          add
        </span>
        Add widget
      </button>
      {canUndo ? (
        <button type="button" onClick={onUndo} className={`${btn} text-warm-100 hover:bg-veil/10`}>
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            undo
          </span>
          Undo reset
        </button>
      ) : (
        <button type="button" onClick={onReset} disabled={!canReset} className={`${btn} text-warm-300 hover:bg-veil/10`}>
          Reset to default
        </button>
      )}
      <button type="button" onClick={onDone} className={`${btn} bg-primary-container text-[#1a1210] hover:brightness-110`}>
        Done
      </button>
    </motion.div>
  );
}

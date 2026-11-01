"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Copy, Download, Link2, Share, X } from "lucide-react";
import { track } from "@/lib/analytics";
import {
  availableShareActions,
  shareEventParams,
  SHARE_FORMAT_LABELS,
  SHARE_FORMATS,
  type ShareAction,
  type ShareCapabilities,
  type ShareFormat,
  type ShareSurface,
} from "@/lib/share";

/**
 * The share sheet: a preview of the card, a landscape/portrait toggle, and
 * whichever of Share / Download / Copy image / Copy link this browser can
 * actually do.
 *
 * **One renderer, many sources.** The sheet does not know how a card is made.
 * It is handed `render(format, variant)`, which for the three data cards
 * fetches a PNG from `/api/share/**` and for an answer paints one on a
 * canvas. Each result is cached per format and variant for the life of the
 * sheet, so flipping the toggle back is instant and every action works on the
 * exact bytes the reader is looking at.
 *
 * **Actions are feature-tested, never sniffed**, and an unsupported one is
 * absent rather than disabled (`availableShareActions`). Share appears only
 * once a real PNG exists, because `navigator.canShare({ files })` has to be
 * asked about an actual file — a browser can share some file types and not
 * others.
 *
 * **Keyboard.** The listener is on `window` in the *capture* phase and stops
 * the event. That is not belt and braces: the Pitwall panel this sheet opens
 * over has its own bubble-phase Escape-closes-the-panel and Tab-trap listener
 * on `window`. Without capture, Escape would close the sheet *and* the panel
 * behind it, and Tab would be yanked back into the panel the moment focus
 * left it — out of the sheet.
 *
 * Focus moves to the dialog on open and back to the opener on close, guarded
 * for an opener that has since left the DOM — the same contract as
 * `use-modal-dialog.ts`, reimplemented only because of the capture-phase
 * requirement above.
 */

export interface ShareRenderResult {
  blob: Blob;
  /** Shown under the preview when the card is not quite what was asked for. */
  note?: string;
}

export interface ShareVariant {
  id: string;
  label: string;
}

export interface ShareSheetProps {
  open: boolean;
  onClose: () => void;
  surface: ShareSurface;
  heading: string;
  render: (format: ShareFormat, variant: string) => Promise<ShareRenderResult>;
  /** Path of the card image for Copy link. Absent for cards with no URL (answers). */
  linkFor?: (format: ShareFormat, variant: string) => string;
  filenameFor: (format: ShareFormat, variant: string) => string;
  /** e.g. Race / Sprint. Omitted or a single entry draws no toggle. */
  variants?: ShareVariant[];
}

type Entry =
  | { status: "ready"; blob: Blob; url: string; note?: string; canShareFiles: boolean }
  | { status: "error"; message: string };

const ACTION_COPY: Record<ShareAction, { label: string; done: string }> = {
  share: { label: "Share", done: "Shared" },
  download: { label: "Download PNG", done: "Downloaded" },
  copy_image: { label: "Copy image", done: "Image copied" },
  copy_link: { label: "Copy link", done: "Link copied" },
};

const ACTION_ICON: Record<ShareAction, typeof Share> = {
  share: Share,
  download: Download,
  copy_image: Copy,
  copy_link: Link2,
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function staticCapabilities(): Omit<ShareCapabilities, "canShareFiles"> {
  if (typeof window === "undefined") return { canCopyImage: false, canCopyText: false };
  const clipboard = navigator.clipboard;
  return {
    canCopyImage: typeof window.ClipboardItem === "function" && typeof clipboard?.write === "function",
    canCopyText: typeof clipboard?.writeText === "function",
  };
}

function canShareFile(file: File): boolean {
  try {
    return typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export default function ShareSheet(props: ShareSheetProps) {
  // Mounted only while open, so every open starts with fresh state and the
  // object URLs of a previous open are already revoked.
  return createPortal(
    <AnimatePresence>{props.open && <SheetBody key="sheet" {...props} />}</AnimatePresence>,
    document.body
  );
}

function SheetBody({ onClose, surface, heading, render, linkFor, filenameFor, variants }: ShareSheetProps) {
  const reduce = useReducedMotion();
  const [format, setFormat] = useState<ShareFormat>("landscape");
  const [variant, setVariant] = useState<string>(variants?.[0]?.id ?? "");
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<{ action: ShareAction; ok: boolean; text: string } | null>(null);
  const [caps] = useState(staticCapabilities);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const requested = useRef(new Set<string>());
  const urls = useRef<string[]>([]);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const key = `${variant}|${format}`;
  const entry = entries[key];

  // Ask for the current card once per key (and again after Retry). State is
  // only ever set from the promise callbacks, never synchronously here.
  useEffect(() => {
    const id = `${key}#${attempt}`;
    const asked = requested.current;
    if (asked.has(id)) return;
    asked.add(id);
    let cancelled = false;
    render(format, variant).then(
      ({ blob, note }) => {
        const url = URL.createObjectURL(blob);
        urls.current.push(url);
        if (cancelled) return;
        const file = new File([blob], filenameFor(format, variant), { type: "image/png" });
        setEntries((prev) => ({ ...prev, [key]: { status: "ready", blob, url, note, canShareFiles: canShareFile(file) } }));
      },
      (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error && error.message ? error.message : "The image could not be made.";
        setEntries((prev) => ({ ...prev, [key]: { status: "error", message } }));
      }
    );
    return () => {
      cancelled = true;
      // A cancelled request may be asked for again (StrictMode remounts,
      // a fast toggle back), so it is forgotten rather than left pending.
      asked.delete(id);
    };
  }, [key, attempt, format, variant, render, filenameFor]);

  // Revoke every preview URL when the sheet goes away.
  useEffect(() => {
    const created = urls.current;
    return () => created.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  // Focus, scroll lock and the capture-phase keyboard handling.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      e.stopPropagation();
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0
      );
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? dialog.contains(active) : false;
      const index = active ? focusable.indexOf(active) : -1;
      if (e.shiftKey) {
        if (!inside || index <= 0) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || index === focusable.length - 1) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  const ready = entry?.status === "ready" ? entry : null;
  const actions = availableShareActions(
    { ...caps, canShareFiles: Boolean(ready?.canShareFiles) },
    { hasLink: Boolean(linkFor) }
  );

  const run = useCallback(
    async (action: ShareAction) => {
      if (!ready) return;
      const filename = filenameFor(format, variant);
      try {
        if (action === "download") {
          const a = document.createElement("a");
          a.href = ready.url;
          a.download = filename;
          a.rel = "noopener";
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else if (action === "share") {
          const file = new File([ready.blob], filename, { type: "image/png" });
          await navigator.share({ files: [file], title: heading });
        } else if (action === "copy_image") {
          // A Promise inside the ClipboardItem, not the blob itself: Safari
          // only honours a write whose item was created synchronously inside
          // the click, and accepts the data arriving later.
          await navigator.clipboard.write([new ClipboardItem({ "image/png": Promise.resolve(ready.blob) })]);
        } else if (action === "copy_link" && linkFor) {
          await navigator.clipboard.writeText(new URL(linkFor(format, variant), window.location.origin).href);
        }
        track("share", shareEventParams(surface, action));
        setStatus({ action, ok: true, text: ACTION_COPY[action].done });
      } catch (error) {
        // Dismissing the system share sheet is not a failure.
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus({
          action,
          ok: false,
          text:
            action === "copy_image"
              ? "This browser wouldn't copy the image. Download it instead."
              : action === "share"
                ? "Sharing didn't work here. Download the image instead."
                : "That didn't work. Try again.",
        });
      }
    },
    [ready, filenameFor, format, variant, heading, linkFor, surface]
  );

  const { width, height } = SHARE_FORMATS[format];
  const toggleClass = (active: boolean) =>
    `relative min-h-10 flex-1 rounded-lg px-3 text-xs transition-[color,background-color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame-bright/60 ${
      active ? "bg-primary-container/18 font-bold text-primary" : "font-semibold text-warm-300 hover:text-on-background"
    }`;

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-6" data-share-sheet>
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-surface-container-lowest/70 backdrop-blur-[6px]"
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      />
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-sheet-heading"
        tabIndex={-1}
        initial={reduce ? false : { opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 16 }}
        transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
        className="relative flex max-h-[92dvh] w-full flex-col gap-4 overflow-y-auto rounded-t-2xl border border-white/10 bg-surface-container-low/97 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_20px_60px_rgba(0,0,0,0.55)] outline-none backdrop-blur-2xl sm:max-w-[560px] sm:rounded-2xl sm:p-6"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="share-sheet-heading" className="font-[family-name:var(--font-headline)] text-lg font-extrabold tracking-[-0.3px]">
            {heading}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="relative flex h-8 w-8 items-center justify-center rounded-full text-warm-300 transition-[background-color,color,transform] duration-150 before:absolute before:-inset-1 before:content-[''] hover:bg-white/5 hover:text-on-background active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame-bright/60"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        {/* Preview. The box takes the card's aspect ratio before the image
            exists, so the sheet does not jump when it arrives. Portrait is
            capped in height so the actions stay on screen on a phone. */}
        <div className="flex justify-center">
          <div
            className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-surface-container"
            style={{
              aspectRatio: `${width} / ${height}`,
              maxWidth: format === "portrait" ? "min(100%, calc(46dvh * 0.8))" : "100%",
            }}
            data-share-preview={ready ? "ready" : entry?.status === "error" ? "error" : "loading"}
          >
            {ready ? (
              // eslint-disable-next-line @next/next/no-img-element -- a blob: URL; next/image cannot optimise it
              <img src={ready.url} alt={`${heading} — ${SHARE_FORMAT_LABELS[format].toLowerCase()} image preview`} className="block h-full w-full object-contain" />
            ) : entry?.status === "error" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="text-sm font-medium text-warm-300">{entry.message}</p>
                <button
                  type="button"
                  onClick={() => {
                    setEntries((prev) => {
                      const next = { ...prev };
                      delete next[key];
                      return next;
                    });
                    setAttempt((n) => n + 1);
                  }}
                  className="min-h-10 rounded-lg border border-white/10 px-4 text-xs font-bold text-warm-100 transition-transform duration-150 hover:bg-white/5 active:scale-[0.97]"
                >
                  Try again
                </button>
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className={`absolute inset-0 bg-white/[0.03] ${reduce ? "" : "animate-pulse"}`} />
                <p className="relative text-xs font-semibold text-warm-400">Making the image…</p>
              </div>
            )}
          </div>
        </div>
        {ready?.note && <p className="-mt-1 text-center text-[11px] text-warm-400">{ready.note}</p>}

        <div className="flex flex-col gap-2">
          {variants && variants.length > 1 && (
            <div role="group" aria-label="Session" className="flex gap-1.5 rounded-xl p-[5px] apex-glass-soft">
              {variants.map((v) => (
                <button key={v.id} type="button" aria-pressed={variant === v.id} onClick={() => setVariant(v.id)} className={toggleClass(variant === v.id)}>
                  {v.label}
                </button>
              ))}
            </div>
          )}
          <div role="group" aria-label="Image shape" className="flex gap-1.5 rounded-xl p-[5px] apex-glass-soft">
            {(Object.keys(SHARE_FORMATS) as ShareFormat[]).map((f) => (
              <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)} className={toggleClass(format === f)} data-share-format={f}>
                {SHARE_FORMAT_LABELS[f]}
                <span className="ml-1.5 font-medium text-warm-500">
                  {SHARE_FORMATS[f].width}×{SHARE_FORMATS[f].height}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) => {
            const Icon = status?.action === action && status.ok ? Check : ACTION_ICON[action];
            const primary = action === actions[0];
            return (
              <button
                key={action}
                type="button"
                disabled={!ready}
                onClick={() => run(action)}
                data-share-action={action}
                className={`flex min-h-11 items-center justify-center gap-2 rounded-control px-4 text-xs font-bold transition-[transform,opacity,background-color] duration-150 active:scale-[0.97] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame-bright/60 ${
                  primary ? "text-[#1a1210]" : "apex-glass-soft text-warm-100 hover:border-flame-bright/50"
                } ${actions.length % 2 === 1 && primary ? "col-span-2" : ""}`}
                style={primary ? { background: "linear-gradient(90deg,var(--color-primary),var(--color-primary-container))" } : undefined}
              >
                <Icon size={15} aria-hidden />
                {ACTION_COPY[action].label}
              </button>
            );
          })}
        </div>

        <p role="status" aria-live="polite" className={`min-h-4 text-center text-[11px] font-semibold ${status?.ok === false ? "text-error" : "text-warm-400"}`}>
          {status?.text ?? ""}
        </p>
      </motion.div>
    </div>
  );
}

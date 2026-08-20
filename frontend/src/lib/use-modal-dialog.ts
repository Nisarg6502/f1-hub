"use client";

/**
 * The focus behaviour every overlay in this app needs, extracted from
 * `pitwall-assistant-panel.tsx` — which was the only surface that had it.
 *
 * The four `createPortal` modals (`driver-modal`, `driver-compare-modal`,
 * `circuit-details-modal`, `circuit-compare-modal`) each shipped with a bare
 * `div.fixed.inset-0`: no `role="dialog"`, no `aria-modal`, and no focus
 * containment. A production audit measured the consequence directly — with the
 * driver card open, ten consecutive Tab presses all landed on driver cards
 * *behind* the overlay, and `document.activeElement` never entered the modal at
 * all. Escape closed it but left focus wherever tabbing had stranded it.
 *
 * What this hook owns, and why each piece is here rather than at the call site:
 *
 * - **Opener capture and restore.** Captured on mount, restored on unmount,
 *   guarded by `document.contains` because the opener can legitimately be gone
 *   by the time the modal closes (a result row in a search list that has since
 *   been cleared).
 * - **Initial focus on the dialog container itself**, not its first control.
 *   Every one of these modals opens with a Close button, and the APG is
 *   explicit that focusing a destructive/dismissing control first is the wrong
 *   default. The container needs `tabIndex={-1}` for this; Chrome does not
 *   paint a `:focus-visible` ring for programmatic focus on a non-input, so
 *   this costs nothing visually.
 * - **A Tab cycle that cannot leak.** Focus already outside the scope (a
 *   programmatic blur, or the opener never having been left) is treated as
 *   "at the edge" so the next Tab snaps back in rather than walking the page
 *   behind the overlay. Focus sitting on the container itself (index `-1` but
 *   inside) is handled explicitly: forward falls through to the browser, which
 *   lands on the first control naturally, while Shift+Tab must be redirected to
 *   the last or it escapes backwards.
 * - **`body.overflow`**, restored to whatever it actually was rather than
 *   assumed.
 *
 * `getScope` exists for one real case: `circuit-details-modal` renders a
 * full-size image lightbox as a *sibling* of its panel, so while that lightbox
 * is open the trap has to move to it. Resolved per keystroke rather than
 * captured, so it tracks state without re-subscribing the listener.
 *
 * Callbacks are read through refs updated in a commit-phase effect rather than
 * being effect dependencies. This is not a micro-optimisation: these modals are
 * handed inline arrows (`onClose={() => setSelectedDriver(null)}`), so a
 * dependency on `onClose` would re-run the effect on every parent render — and
 * re-running it re-captures `previouslyFocused`, which by then is the modal's
 * own focused element. The restore would then "return" focus into a subtree
 * that is being unmounted.
 */

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Rendered-and-reachable controls inside `scope`, in DOM order.
 *
 * `getClientRects().length` rather than the `offsetParent !== null` check the
 * assistant panel uses: `offsetParent` is `null` for any `position: fixed`
 * element, so that test silently drops fixed-positioned controls from the
 * cycle. Both agree on `display: none`, which is the case that actually
 * matters here.
 */
function focusableWithin(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0 && !el.hasAttribute("inert")
  );
}

export interface ModalDialogOptions {
  /** Dismiss the dialog. Also the default Escape handler. */
  onClose: () => void;
  /**
   * `false` leaves the page untouched — no listener, no scroll lock, no focus
   * move. For modals that stay mounted while closed (`circuit-details-modal`
   * takes an `isOpen` prop rather than being unmounted by its parent).
   */
  enabled?: boolean;
  /**
   * Escape override, for a dialog with an inner layer to dismiss first.
   * Defaults to `onClose`.
   */
  onEscape?: () => void;
  /**
   * The subtree Tab is confined to, resolved on each keystroke. Defaults to the
   * returned ref's element.
   */
  getScope?: () => HTMLElement | null;
}

export function useModalDialog<T extends HTMLElement = HTMLDivElement>(
  options: ModalDialogOptions
): RefObject<T | null> {
  const { onClose, enabled = true, onEscape, getScope } = options;

  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  const onEscapeRef = useRef(onEscape);
  const getScopeRef = useRef(getScope);

  // Commit-phase sync, deliberately without a dependency array: every render
  // refreshes the callbacks the (single, long-lived) listener will call.
  useEffect(() => {
    onCloseRef.current = onClose;
    onEscapeRef.current = onEscape;
    getScopeRef.current = getScope;
  });

  useEffect(() => {
    if (!enabled) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        (onEscapeRef.current ?? onCloseRef.current)();
        return;
      }
      if (e.key !== "Tab") return;

      const scope = getScopeRef.current?.() ?? dialogRef.current;
      if (!scope) return;

      const focusable = focusableWithin(scope);
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? scope.contains(active) : false;

      if (focusable.length === 0) {
        // Nothing to cycle through, but Tab still must not walk out of the
        // overlay — park it on the container.
        e.preventDefault();
        scope.focus?.();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const index = active ? focusable.indexOf(active) : -1;

      if (e.shiftKey) {
        // Backwards off the first control, off the container itself, or from
        // outside the scope entirely — all wrap to the last.
        if (!inside || index === 0 || index === -1) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || index === focusable.length - 1) {
        // Forwards off the last control (or from outside) wraps to the first.
        // Forwards *from the container* deliberately falls through: the
        // browser's own order already lands on `first`.
        e.preventDefault();
        first.focus();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    dialogRef.current?.focus?.();

    return () => {
      document.body.style.overflow = previousOverflow || "auto";
      window.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [enabled]);

  return dialogRef;
}

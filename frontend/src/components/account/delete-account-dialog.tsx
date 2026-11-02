"use client";

import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useModalDialog } from "@/lib/use-modal-dialog";
import { authClient } from "@/lib/auth-client";

/**
 * The account-deletion confirmation.
 *
 * Typing the word DELETE, rather than a second "Are you sure?" button,
 * because this is the one irreversible action in the app and a two-tap
 * confirmation is exactly what muscle memory clicks straight through. The
 * dialog states what goes — including chat history, which people may not
 * think of as "account data" — before asking.
 *
 * Escape, the Tab trap and focus return come from `useModalDialog`, the same
 * hook the driver and circuit modals use. Escape is disabled while the
 * request is in flight so the dialog cannot vanish over a half-finished
 * deletion.
 */
export default function DeleteAccountDialog({
  open,
  onClose,
  email,
}: {
  open: boolean;
  onClose: () => void;
  email: string;
}) {
  const reduce = useReducedMotion();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = () => {
    if (busy) return;
    setTyped("");
    setFailed(false);
    onClose();
  };
  const dialogRef = useModalDialog<HTMLDivElement>({ onClose: close, enabled: open });
  const confirmed = typed.trim().toUpperCase() === "DELETE";
  // Portals need `document`; render nothing on the server and on the
  // hydration pass so the server and client trees agree.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  async function confirmDelete() {
    if (!confirmed) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "delete-my-account" }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // The server already cleared the cookie; this resets the client's
      // cached session so the header updates before the page changes.
      await authClient.getSession({ query: { disableCookieCache: true } }).catch(() => null);
      window.location.assign("/?account=deleted");
    } catch {
      setBusy(false);
      setFailed(true);
    }
  }

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-4">
          <motion.button
            type="button"
            aria-label="Cancel"
            onClick={close}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0.1 : 0.18 }}
            className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
          />
          <motion.div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            aria-describedby="delete-body"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
            transition={reduce ? { duration: 0.1 } : { type: "spring", stiffness: 420, damping: 36 }}
            className="relative w-full max-w-[440px] rounded-2xl bg-surface-container-low border border-white/[0.12] shadow-[0_30px_80px_rgba(0,0,0,0.7)] p-6"
          >
            <h2 id="delete-title" className="font-[family-name:var(--font-headline)] font-bold text-xl text-on-background">
              Delete your account?
            </h2>
            <div id="delete-body" className="text-sm text-warm-200 leading-relaxed mt-3">
              <p>
                This permanently removes <strong className="text-on-background break-all">{email}</strong>{" "}
                from APEX, along with:
              </p>
              <ul className="list-disc pl-5 mt-2 space-y-1 text-warm-300">
                <li>your profile, favourites and preferences</li>
                <li>your saved chat conversations</li>
                <li>every signed-in session, on every device</li>
              </ul>
              <p className="mt-3">
                It can&apos;t be undone. You can export your data first, and you
                can always keep using APEX without an account.
              </p>
            </div>
            <label htmlFor="delete-confirm" className="block text-xs font-semibold text-warm-300 mt-5 mb-2">
              Type DELETE to confirm
            </label>
            <input
              id="delete-confirm"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy}
              className="w-full min-h-[44px] rounded-xl bg-black/30 border border-white/[0.12] px-3.5 text-[15px] text-on-background outline-none focus-visible:border-error/70 focus-visible:outline-2 focus-visible:outline-error/40"
            />
            {failed && (
              <p role="alert" className="text-xs text-error mt-2">
                The account couldn&apos;t be fully deleted just now. Please try
                again — if you were signed out part-way, sign back in and retry
                to finish.
              </p>
            )}
            <div className="flex flex-col-reverse sm:flex-row gap-2.5 mt-5">
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="flex-1 min-h-[44px] rounded-xl border border-white/[0.14] font-semibold text-[13px] text-warm-200 hover:bg-white/[0.05] transition disabled:opacity-50"
              >
                Keep my account
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={!confirmed || busy}
                className="flex-1 min-h-[44px] rounded-xl bg-[#c2310f] text-white font-bold text-[13px] hover:brightness-110 transition disabled:opacity-40"
              >
                {busy ? "Deleting…" : "Delete account"}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}

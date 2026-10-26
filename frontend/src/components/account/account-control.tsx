"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { authClient, useAccountState } from "@/lib/auth-client";
import Avatar from "./avatar";

/**
 * The account control in the global header.
 *
 *   signed out   a "Sign in" pill (an icon below `sm`, where the bar has no
 *                room for a word)
 *   signed in    the avatar, opening a two-item menu: Account, Sign out
 *   loading      a fixed 32px placeholder, so the bar does not jump when the
 *                session arrives
 *   unavailable  nothing at all — a deployment without accounts configured
 *                looks exactly as the site did before accounts existed
 *
 * Kept to one self-contained component and one line in `app/layout.tsx` so
 * the header insertion is trivial to merge alongside the spoiler-free
 * branch's toggle, which lands in the same row.
 *
 * Reads the session on the client rather than in the layout: reading it on
 * the server would force every page in the app to render per request, for a
 * 32px control.
 */
export default function AccountControl() {
  const account = useAccountState();
  const pathname = usePathname() ?? "";

  if (account.status === "unavailable") return null;
  if (account.status === "loading") {
    return <span aria-hidden="true" className="block w-8 h-8 rounded-full bg-white/[0.06]" />;
  }
  if (account.status === "signed-out") {
    // Return here after signing in. The sign-in page itself is excluded so
    // the parameter cannot point back at the form.
    const next =
      pathname && pathname !== "/signin" ? `?next=${encodeURIComponent(pathname)}` : "";
    return (
      <Link
        href={`/signin${next}`}
        aria-label="Sign in"
        className="relative inline-flex items-center gap-1.5 rounded-full border border-white/[0.14] px-2 sm:px-3.5 h-8 font-semibold text-xs text-warm-200 hover:text-on-background hover:bg-white/[0.05] transition-colors before:absolute before:-top-1 before:-bottom-1 before:-left-1 before:-right-1 before:content-['']"
      >
        <span className="material-symbols-outlined text-[18px] sm:hidden" aria-hidden="true">
          person
        </span>
        <span className="hidden sm:inline">Sign in</span>
      </Link>
    );
  }
  return <AccountMenu user={account.user} />;
}

function AccountMenu({
  user,
}: {
  user: { name: string; email: string; image?: string | null };
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const reduce = useReducedMotion();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Escape, outside clicks and focus placement — the subset of menu-button
  // behaviour that matters for two items.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []
      );
      if (items.length === 0) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length].focus();
    }
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      setSigningOut(false);
      setOpen(false);
      // The account page has nothing to show a signed-out visitor.
      if (pathname.startsWith("/account")) router.push("/");
      router.refresh();
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account menu for ${user.name || user.email}`}
        onClick={() => setOpen((value) => !value)}
        className="relative flex items-center rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary before:absolute before:-top-1 before:-bottom-1 before:-left-1 before:-right-1 before:content-['']"
      >
        <Avatar name={user.name} email={user.email} image={user.image} size={32} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="Account"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: reduce ? 0.1 : 0.14, ease: "easeOut" }}
            style={{ transformOrigin: "top right" }}
            className="absolute right-0 top-[calc(100%+10px)] z-[70] w-60 rounded-2xl bg-surface-container-low/97 backdrop-blur-2xl border border-white/[0.1] shadow-[0_18px_50px_rgba(0,0,0,0.55)] p-1.5"
          >
            <div className="px-3 pt-2 pb-2.5 border-b border-white/[0.07] mb-1">
              <p className="font-semibold text-sm text-on-background truncate">
                {user.name || "Signed in"}
              </p>
              <p className="text-xs text-warm-400 truncate">{user.email}</p>
            </div>
            <Link
              href="/account"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 min-h-[40px] rounded-xl px-3 text-sm font-medium text-warm-200 hover:bg-white/[0.06] hover:text-on-background focus-visible:bg-white/[0.06] focus-visible:outline-none transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                manage_accounts
              </span>
              Account
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={signOut}
              disabled={signingOut}
              className="w-full flex items-center gap-2.5 min-h-[40px] rounded-xl px-3 text-sm font-medium text-warm-200 hover:bg-white/[0.06] hover:text-on-background focus-visible:bg-white/[0.06] focus-visible:outline-none transition-colors disabled:opacity-60"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                logout
              </span>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

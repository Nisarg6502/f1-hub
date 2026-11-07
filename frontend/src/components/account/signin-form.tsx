"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { authClient } from "@/lib/auth-client";
import type { AuthErrorCopy } from "@/lib/auth-errors";
import {
  AUTH_MODES,
  authModeHref,
  isOriginRejection,
  nextTabIndex,
  originRejectionMessage,
  parseAuthMode,
  type AuthMode,
} from "@/lib/auth-mode";

/**
 * The /signin card: "Sign in" and "Create account" tabs over the same two
 * flows — Google, or an email link — then a "check your email" state with a
 * rate-limited resend.
 *
 * The two tabs are one mechanism on purpose. Better Auth's magic link and
 * Google both create the account the first time an address is seen, so
 * "sign up" is not a different endpoint; it is the same request with a
 * display name attached and copy that says what is about to happen. Keeping
 * them as two flows would only invent ways for them to drift apart.
 *
 * The tab is mirrored in `?mode=signup` (with `history.replaceState`, no
 * navigation) so the header's "Create account" link and a shared URL both
 * land on the right one, and Back does not walk through tab clicks.
 *
 * The resend cooldown here is a courtesy, not the limit. The real limits are
 * server-side (per IP in Better Auth, per address in `lib/auth.ts`); this
 * only stops a second tap from looking like nothing happened, and tells the
 * visitor how long to wait instead of letting them hit the server's refusal.
 */

const RESEND_COOLDOWN_SECONDS = 60;
const NAME_MAX_LENGTH = 60;

type Phase = { name: "form" } | { name: "sent"; email: string };

const COPY: Record<
  AuthMode,
  {
    tab: string;
    heading: string;
    intro: string;
    google: string;
    submit: string;
    footnote: string;
    sentHeading: string;
  }
> = {
  signin: {
    tab: "Sign in",
    heading: "Sign in",
    intro:
      "Welcome back. Pick up your saved chat history, favourites and preferences on this device. No passwords.",
    google: "Continue with Google",
    submit: "Email me a sign-in link",
    footnote:
      "We'll email a link that signs you in — no password. A new address creates an account.",
    sentHeading: "Check your email",
  },
  signup: {
    tab: "Create account",
    heading: "Create your account",
    intro:
      "Optional and free. Everything in APEX works without one — an account adds chat history, favourites and preferences that follow you across devices. No passwords.",
    google: "Sign up with Google",
    submit: "Create account with an email link",
    footnote:
      "We'll email a link that creates your account and signs you in. Already have one? The same link just signs you in.",
    sentHeading: "Confirm your email",
  },
};

export default function SignInForm({
  googleEnabled,
  next,
  error,
  expiresInMinutes,
  initialMode,
  canonicalUrl,
}: {
  googleEnabled: boolean;
  next: string;
  error: AuthErrorCopy | null;
  expiresInMinutes: number;
  initialMode: AuthMode;
  /** `BETTER_AUTH_URL`, to point at when a sign-in is refused for its origin. */
  canonicalUrl: string | null;
}) {
  const reduce = useReducedMotion();
  const baseId = useId();
  // The URL is the source of truth for the tab, so the header's links and
  // Back/Forward all agree with it. `initialMode` (parsed on the server)
  // covers the first render; after that `replaceState` below feeds Next's
  // router, which updates `useSearchParams`.
  const searchParams = useSearchParams();
  const mode: AuthMode = searchParams ? parseAuthMode(searchParams.get("mode")) : initialMode;
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pending, setPending] = useState<"email" | "google" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [originRefused, setOriginRefused] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [resent, setResent] = useState(false);
  const [showError, setShowError] = useState(Boolean(error));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const copy = COPY[mode];
  const tabId = (value: AuthMode) => `${baseId}-tab-${value}`;
  const panelId = `${baseId}-panel`;

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  // Move focus to the new heading when the card changes state, so a screen
  // reader announces "Check your email" instead of silence.
  useEffect(() => {
    if (phase.name === "sent") headingRef.current?.focus();
  }, [phase.name]);

  function selectMode(value: AuthMode) {
    if (value === mode) return;
    setPhase({ name: "form" });
    setMessage(null);
    setOriginRefused(false);
    // A server-side error from the previous attempt belongs to that attempt.
    setShowError(false);
    // `null` state, NOT `window.history.state`: Next 16 treats a state object
    // carrying its own `__NA` marker as one of its internal calls and skips
    // syncing the URL into the router, so `useSearchParams` (and with it the
    // selected tab) would never change. With `null` Next copies its internal
    // state across itself and updates the router.
    window.history.replaceState(null, "", authModeHref(value, window.location.search));
  }

  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const current = AUTH_MODES.indexOf(mode);
    const target = nextTabIndex(event.key, current, AUTH_MODES.length);
    if (target === null) return;
    event.preventDefault();
    // Automatic activation: the panels are cheap, so moving focus selects.
    selectMode(AUTH_MODES[target]);
    tabRefs.current[target]?.focus();
  }

  const callbacks = {
    callbackURL: next,
    newUserCallbackURL: next === "/" ? "/account?welcome=1" : next,
    errorCallbackURL: "/signin",
  };

  function reportFailure(
    failure: { status?: number; message?: string; code?: string },
    fallback: string,
  ) {
    if (isOriginRejection(failure)) {
      setOriginRefused(true);
      setMessage(originRejectionMessage(canonicalUrl));
      return;
    }
    setMessage(fallback);
  }

  async function sendLink(address: string): Promise<boolean> {
    setMessage(null);
    setOriginRefused(false);
    setPending("email");
    try {
      const name = mode === "signup" ? displayName.trim().slice(0, NAME_MAX_LENGTH) : "";
      const { error: sendError } = await authClient.signIn.magicLink({
        email: address,
        // Only used when this address has no account yet; the plugin ignores
        // it for an existing one, so a sign-in can never rename anybody.
        ...(name ? { name } : {}),
        ...callbacks,
      });
      if (sendError) {
        reportFailure(
          sendError,
          sendError.status === 429
            ? sendError.message ||
                "Too many sign-in links requested. Wait a few minutes and try again."
            : sendError.status === 400
              ? "That doesn't look like an email address."
              : "We couldn't send the link just now. Please try again in a moment.",
        );
        return false;
      }
      setCooldown(RESEND_COOLDOWN_SECONDS);
      return true;
    } catch {
      setMessage("We couldn't reach the server. Check your connection and try again.");
      return false;
    } finally {
      setPending(null);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    if (await sendLink(address)) {
      setResent(false);
      setShowError(false);
      setPhase({ name: "sent", email: address });
    }
  }

  async function onResend() {
    if (phase.name !== "sent" || cooldown > 0) return;
    if (await sendLink(phase.email)) setResent(true);
  }

  async function onGoogle() {
    setMessage(null);
    setOriginRefused(false);
    setPending("google");
    try {
      const { error: googleError } = await authClient.signIn.social({
        provider: "google",
        ...callbacks,
      });
      // On success the browser is already navigating to Google.
      if (googleError) {
        setPending(null);
        reportFailure(
          googleError,
          "Google sign-in couldn't start. Please try again, or use an email link.",
        );
      }
    } catch {
      setPending(null);
      setMessage("We couldn't reach the server. Check your connection and try again.");
    }
  }

  const fade = {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 6 },
    animate: reduce ? { opacity: 1 } : { opacity: 1, y: 0 },
    exit: reduce ? { opacity: 0 } : { opacity: 0, y: -6 },
    transition: { duration: reduce ? 0.1 : 0.2, ease: "easeOut" as const },
  };

  // Where to send someone whose sign-in was refused for its origin: the same
  // page, on the address sign-in is registered for.
  const canonicalSignin = (() => {
    if (!originRefused || !canonicalUrl || typeof window === "undefined") return null;
    try {
      return new URL(authModeHref(mode, window.location.search), canonicalUrl).toString();
    } catch {
      return null;
    }
  })();

  return (
    <>
      <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[44px] tracking-[-1.2px] mt-2">
        {copy.heading}
      </h1>
      <p className="text-sm text-warm-300 leading-relaxed mt-3 mb-6">{copy.intro}</p>

      <div
        role="tablist"
        aria-label="Account"
        className="grid grid-cols-2 gap-1 rounded-xl bg-black/30 border border-white/[0.1] p-1 mb-4"
      >
        {AUTH_MODES.map((value, index) => {
          const selected = value === mode;
          return (
            <button
              key={value}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              id={tabId(value)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectMode(value)}
              onKeyDown={onTabKeyDown}
              className={`relative min-h-[40px] rounded-lg text-[13px] font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                selected
                  ? "text-[#1a1210]"
                  : "text-warm-300 hover:text-on-background hover:bg-white/[0.05]"
              }`}
            >
              {selected && (
                <motion.span
                  layoutId={reduce ? undefined : `${baseId}-tab-pill`}
                  aria-hidden="true"
                  className="absolute inset-0 rounded-lg bg-primary-container shadow-[0_0_18px_rgb(var(--rgb-primary-container)_/_0.35)]"
                  transition={{ duration: 0.2, ease: "easeOut" }}
                />
              )}
              <span className="relative">{COPY[value].tab}</span>
            </button>
          );
        })}
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(mode)}
        className="apex-glass rounded-2xl p-5 sm:p-6"
      >
        {error && showError && phase.name === "form" && (
          <div
            role="alert"
            className="mb-5 rounded-xl border border-error/30 bg-error-container/30 px-4 py-3"
          >
            <p className="font-semibold text-sm text-on-background">{error.title}</p>
            <p className="text-[13px] text-warm-200 leading-relaxed mt-1">{error.body}</p>
          </div>
        )}

        <AnimatePresence mode="wait" initial={false}>
          {phase.name === "form" ? (
            <motion.div key={`form-${mode}`} {...fade}>
              {googleEnabled && (
                <>
                  <button
                    type="button"
                    onClick={onGoogle}
                    disabled={pending !== null}
                    className="w-full min-h-[44px] flex items-center justify-center gap-2.5 rounded-xl bg-[#f6f1ea] text-[#1a1210] font-semibold text-sm hover:brightness-95 transition disabled:opacity-60"
                  >
                    <GoogleMark />
                    {pending === "google" ? "Opening Google…" : copy.google}
                  </button>
                  <div className="flex items-center gap-3 my-5" aria-hidden="true">
                    <span className="h-px flex-1 bg-white/[0.1]" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-warm-500">
                      or
                    </span>
                    <span className="h-px flex-1 bg-white/[0.1]" />
                  </div>
                </>
              )}

              <form onSubmit={onSubmit}>
                {mode === "signup" && (
                  <div className="mb-3">
                    <label
                      htmlFor={`${baseId}-name`}
                      className="block text-xs font-semibold text-warm-300 mb-2"
                    >
                      Display name <span className="font-normal text-warm-500">(optional)</span>
                    </label>
                    <input
                      id={`${baseId}-name`}
                      type="text"
                      autoComplete="nickname"
                      maxLength={NAME_MAX_LENGTH}
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="What should we call you?"
                      className="w-full min-h-[44px] rounded-xl bg-black/30 border border-white/[0.12] px-3.5 text-[15px] text-on-background placeholder:text-warm-600 outline-none focus-visible:border-primary/70 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary/40"
                    />
                  </div>
                )}
                <label
                  htmlFor={`${baseId}-email`}
                  className="block text-xs font-semibold text-warm-300 mb-2"
                >
                  Email
                </label>
                <input
                  id={`${baseId}-email`}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className="w-full min-h-[44px] rounded-xl bg-black/30 border border-white/[0.12] px-3.5 text-[15px] text-on-background placeholder:text-warm-600 outline-none focus-visible:border-primary/70 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary/40"
                />
                <button
                  type="submit"
                  disabled={pending !== null}
                  className="mt-3 w-full min-h-[44px] rounded-xl bg-primary-container text-[#1a1210] font-bold text-sm hover:brightness-110 transition disabled:opacity-60"
                >
                  {pending === "email" ? "Sending…" : copy.submit}
                </button>
                <p className="text-xs text-warm-400 leading-relaxed mt-3">{copy.footnote}</p>
              </form>
            </motion.div>
          ) : (
            <motion.div key="sent" {...fade}>
              <span
                className="material-symbols-outlined text-[32px] text-primary"
                aria-hidden="true"
              >
                mark_email_read
              </span>
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="font-[family-name:var(--font-headline)] font-bold text-xl text-on-background mt-2 outline-none"
              >
                {copy.sentHeading}
              </h2>
              <p className="text-sm text-warm-200 leading-relaxed mt-2">
                We sent a {mode === "signup" ? "link that creates your account" : "sign-in link"} to{" "}
                <strong className="text-on-background break-all">{phase.email}</strong>.
              </p>
              <p className="text-sm text-warm-300 leading-relaxed mt-2">
                It expires in {expiresInMinutes} minutes and works once. Open it on
                this device to sign in here.
              </p>
              <p className="text-xs text-warm-400 leading-relaxed mt-3">
                Nothing after a minute or two? Check spam, or send another.
              </p>

              <div className="flex flex-col sm:flex-row gap-2.5 mt-5">
                <button
                  type="button"
                  onClick={onResend}
                  disabled={cooldown > 0 || pending !== null}
                  className="flex-1 min-h-[44px] rounded-xl border border-white/[0.14] font-semibold text-[13px] text-warm-200 hover:bg-white/[0.05] transition disabled:opacity-60"
                >
                  {pending === "email"
                    ? "Sending…"
                    : cooldown > 0
                      ? `Resend in ${cooldown}s`
                      : "Resend link"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPhase({ name: "form" });
                    setMessage(null);
                  }}
                  className="flex-1 min-h-[44px] rounded-xl font-semibold text-[13px] text-warm-300 hover:text-on-background hover:bg-white/[0.05] transition"
                >
                  Use a different email
                </button>
              </div>
              <p aria-live="polite" className="text-xs text-warm-300 mt-3 min-h-[1rem]">
                {resent ? "Sent again. Any of the links will work once, until it expires." : ""}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {message && (
          <div role="alert" className="mt-4">
            <p className="text-[13px] text-error leading-relaxed">{message}</p>
            {canonicalSignin && (
              <a
                href={canonicalSignin}
                className="inline-flex items-center gap-1 mt-2 text-[13px] font-semibold text-primary underline underline-offset-2 hover:text-on-background"
              >
                Open sign-in on the main address
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  arrow_forward
                </span>
              </a>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Google's "G", drawn inline so the button needs no external image host. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

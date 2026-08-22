"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Route-level error boundary.
 *
 * Every page in this app is `force-dynamic` and fetches from a backend on a
 * free tier that can be cold, rate-limited or briefly down, so an uncaught
 * throw during render is a routine event rather than an exotic one. Without
 * this file all of them landed on Next's stock error screen.
 *
 * `error.message` is deliberately NOT rendered. In production Next replaces it
 * with a generic digest anyway, but the habit matters: this is the boundary
 * that would happily print an internal URL or a query fragment to whoever
 * triggered it. The digest is shown instead, because it is the one token that
 * makes a user's report matchable against a server log.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Goes to the browser console and, in production, to Cloud Logging via the
    // Next server's own error reporting. Nothing is sent anywhere else.
    console.error("Route error:", error);
  }, [error]);

  return (
    <div className="relative z-10 max-w-[1440px] mx-auto px-6 md:px-10 py-20 md:py-28">
      <div className="max-w-[52ch]">
        <p className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500 mb-3">
          Something broke
        </p>
        <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-[28px] tracking-[-0.6px] mb-3">
          This page didn&apos;t load
        </h1>
        <p className="font-medium text-sm leading-relaxed text-warm-300 mb-8">
          Usually this means the data service is briefly unreachable — APEX runs
          on free tiers and they cold-start, rate-limit and occasionally fall
          over. Trying again often works.
        </p>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={reset}
            className="font-bold text-xs px-5 h-[46px] rounded-control apex-glass-soft flex items-center justify-center hover:border-flame-bright/50 transition-[border-color,transform] duration-150 active:scale-95"
          >
            Try again
          </button>
          <Link
            href="/"
            className="font-bold text-xs px-5 h-[46px] rounded-control apex-glass-soft flex items-center justify-center hover:border-flame-bright/50 transition-[border-color,transform] duration-150 active:scale-95"
          >
            Back to home
          </Link>
        </div>

        {error.digest && (
          <p className="font-medium text-xs text-warm-500 mt-8">
            If it keeps happening,{" "}
            <a
              href="https://github.com/Nisarg6502/f1-hub/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-warm-300 transition-colors"
            >
              report it
            </a>{" "}
            and quote this reference:{" "}
            <span className="font-mono text-warm-300">{error.digest}</span>
          </p>
        )}
      </div>
    </div>
  );
}

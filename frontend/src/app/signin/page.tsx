import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, isGoogleConfigured } from "@/lib/auth";
import { isAuthConfigured } from "@/lib/auth-db";
import { describeAuthError } from "@/lib/auth-errors";
import { MAGIC_LINK_TTL_SECONDS } from "@/lib/auth-magic-link";
import SignInForm from "@/components/account/signin-form";

export const metadata: Metadata = {
  title: "Sign in | APEX",
  description:
    "Optional APEX account: sign in with Google or an email link to sync favourites, preferences and chat history across devices.",
  robots: { index: false },
};

/**
 * Rendered per request: whether the Google button shows depends on RUNTIME
 * secrets (Cloud Run injects them when the container starts, long after the
 * build), and so does whether accounts exist at all.
 */
export const dynamic = "force-dynamic";

/** Only same-site paths. `//evil.example` is protocol-relative, so excluded. */
function safeNext(value: string | string[] | undefined): string {
  const next = Array.isArray(value) ? value[0] : value;
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/signin")) {
    return "/";
  }
  return next;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);

  if (!isAuthConfigured()) {
    return (
      <Shell>
        <div className="apex-glass-soft rounded-2xl px-6 py-8 text-center">
          <p className="font-semibold text-on-background">Accounts aren&apos;t switched on here.</p>
          <p className="text-sm text-warm-400 mt-2">
            Everything in APEX works without one.{" "}
            <Link href="/" className="underline hover:text-warm-200">
              Back to the hub
            </Link>
          </p>
        </div>
      </Shell>
    );
  }

  if (await getCurrentUser()) redirect(next === "/" ? "/account" : next);

  const errorParam = Array.isArray(params.error) ? params.error[0] : params.error;

  return (
    <Shell>
      <SignInForm
        googleEnabled={isGoogleConfigured()}
        next={next}
        error={describeAuthError(errorParam)}
        expiresInMinutes={Math.round(MAGIC_LINK_TTL_SECONDS / 60)}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 sm:px-6 md:px-10 pt-11 pb-16">
      <div className="mx-auto w-full max-w-[440px]">
        <span className="font-bold text-xs tracking-[0.18em] uppercase text-flame">Account</span>
        <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[44px] tracking-[-1.2px] mt-2">
          Sign in
        </h1>
        <p className="text-sm text-warm-300 leading-relaxed mt-3 mb-7">
          Optional. Everything in APEX works without an account — signing in
          adds saved chat history, favourites and preferences that follow you
          across devices. No passwords.
        </p>
        {children}
      </div>
    </div>
  );
}

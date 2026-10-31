"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import type { AuthErrorCopy } from "@/lib/auth-errors";
import { useFavourites, usePreferences } from "@/lib/preferences-client";
import { CLOCK_VALUES, type ClockPreference } from "@/lib/preferences";
import { getTeamColor } from "@/lib/team-colors";
import Avatar from "./avatar";
import DeleteAccountDialog from "./delete-account-dialog";

/**
 * `/account`: profile, favourites, preferences, sign-in methods, and the two
 * controls the privacy page promises — export and delete.
 *
 * Every write here is independent and saves on its own (no page-level "Save"
 * button): a favourite is one tap, and making someone also find a save
 * button at the bottom of a long page is how settings get silently lost.
 * Each section reports its own saving / saved / failed state next to the
 * control that caused it.
 */

export interface GridDriver {
  id: string;
  name: string;
  team: string;
}
export interface GridTeam {
  id: string;
  name: string;
}

type SaveState = "idle" | "saving" | "saved" | "failed";

function SaveNote({ state }: { state: SaveState }) {
  const text =
    state === "saving"
      ? "Saving…"
      : state === "saved"
        ? "Saved"
        : state === "failed"
          ? "Couldn't save — try again"
          : "";
  return (
    <span
      aria-live="polite"
      className={`text-xs font-medium ${state === "failed" ? "text-error" : "text-warm-400"}`}
    >
      {text}
    </span>
  );
}

function Section({
  title,
  description,
  children,
  aside,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="apex-glass-soft rounded-2xl p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="font-[family-name:var(--font-headline)] font-bold text-lg text-on-background">
            {title}
          </h2>
          {description && (
            <p className="text-[13px] text-warm-400 leading-relaxed mt-1">{description}</p>
          )}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

const selectClass =
  "w-full min-h-[44px] rounded-xl bg-black/30 border border-white/[0.12] px-3 text-[15px] text-on-background outline-none focus-visible:border-primary/70 focus-visible:outline-2 focus-visible:outline-primary/40";

export default function AccountView({
  user,
  grid,
  providers,
  googleEnabled,
  welcome,
  error,
}: {
  user: { id: string; name: string; email: string; image?: string | null };
  grid: { season: number; drivers: GridDriver[]; teams: GridTeam[] };
  providers: { providerId: string; accountId: string }[];
  googleEnabled: boolean;
  welcome: boolean;
  error: AuthErrorCopy | null;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="px-4 sm:px-6 md:px-10 pt-11 pb-16">
      <div className="mx-auto w-full max-w-[720px]">
        <span className="font-bold text-xs tracking-[0.18em] uppercase text-flame">Account</span>
        <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[44px] tracking-[-1.2px] mt-2 mb-7">
          Your account
        </h1>

        {welcome && (
          <div className="mb-5 rounded-2xl border border-primary/25 bg-primary-container/10 px-5 py-4">
            <p className="font-semibold text-sm text-on-background">You&apos;re signed in.</p>
            <p className="text-[13px] text-warm-200 leading-relaxed mt-1">
              Pick a favourite driver and team below. Your chat history will be
              saved to this account from now on.
            </p>
          </div>
        )}
        {error && (
          <div role="alert" className="mb-5 rounded-2xl border border-error/30 bg-error-container/30 px-5 py-4">
            <p className="font-semibold text-sm text-on-background">{error.title}</p>
            <p className="text-[13px] text-warm-200 leading-relaxed mt-1">{error.body}</p>
          </div>
        )}

        <div className="flex flex-col gap-4">
          <ProfileSection user={user} />
          <FavouritesSection grid={grid} />
          <PreferencesSection />
          <SignInMethodsSection
            email={user.email}
            providers={providers}
            googleEnabled={googleEnabled}
          />

          <Section
            title="Your data"
            description="Everything APEX stores about you, and how to take it with you or erase it. The privacy page explains each item."
          >
            <div className="flex flex-col sm:flex-row gap-2.5">
              <a
                href="/api/me/export"
                download
                className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-white/[0.14] font-semibold text-[13px] text-warm-100 hover:bg-white/[0.05] transition"
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  download
                </span>
                Export my data (JSON)
              </a>
              <button
                type="button"
                onClick={() => setDeleteOpen(true)}
                className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-error/40 font-semibold text-[13px] text-error hover:bg-error-container/30 transition"
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  delete_forever
                </span>
                Delete account
              </button>
            </div>
            <p className="text-xs text-warm-400 leading-relaxed mt-3">
              See <Link href="/privacy" className="underline hover:text-warm-200">privacy</Link>{" "}
              for what is stored and for how long.
            </p>
          </Section>
        </div>
      </div>

      <DeleteAccountDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} email={user.email} />
    </div>
  );
}

function ProfileSection({
  user,
}: {
  user: { name: string; email: string; image?: string | null };
}) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [saved, setSaved] = useState(user.name);
  const [state, setState] = useState<SaveState>("idle");
  const trimmed = name.trim();
  const dirty = trimmed !== saved && trimmed.length > 0;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    setState("saving");
    const { error } = await authClient.updateUser({ name: trimmed.slice(0, 60) });
    if (error) {
      setState("failed");
      return;
    }
    setSaved(trimmed);
    setName(trimmed);
    setState("saved");
    router.refresh();
  }

  return (
    <Section title="Profile">
      <div className="flex items-center gap-4 mb-5">
        <Avatar name={saved} email={user.email} image={user.image} size={56} />
        <div className="min-w-0">
          <p className="font-semibold text-on-background truncate">{saved}</p>
          <p className="text-sm text-warm-400 truncate">{user.email}</p>
        </div>
      </div>
      <form onSubmit={save}>
        <label htmlFor="account-name" className="block text-xs font-semibold text-warm-300 mb-2">
          Display name
        </label>
        <div className="flex gap-2.5">
          <input
            id="account-name"
            value={name}
            maxLength={60}
            autoComplete="name"
            onChange={(event) => {
              setName(event.target.value);
              if (state !== "saving") setState("idle");
            }}
            className={selectClass}
          />
          <button
            type="submit"
            disabled={!dirty || state === "saving"}
            className="flex-none min-h-[44px] px-5 rounded-xl bg-primary-container text-[#1a1210] font-bold text-sm hover:brightness-110 transition disabled:opacity-40"
          >
            Save
          </button>
        </div>
        <div className="mt-2 min-h-[1rem]">
          <SaveNote state={state} />
        </div>
      </form>
      <p className="text-xs text-warm-400 leading-relaxed">
        {user.image
          ? "Your picture comes from your Google account."
          : "Your initials stand in for a picture. Linking Google adds your Google photo."}{" "}
        The email address is how you sign in and can&apos;t be changed here.
      </p>
    </Section>
  );
}

function FavouritesSection({
  grid,
}: {
  grid: { season: number; drivers: GridDriver[]; teams: GridTeam[] };
}) {
  const { status, favourites, setFavourites } = useFavourites();
  const [state, setState] = useState<SaveState>("idle");
  const ready = status === "ready";

  async function change(next: { driverId?: string | null; teamId?: string | null }) {
    setState("saving");
    setState((await setFavourites(next)) ? "saved" : "failed");
  }

  const driverTeam = grid.drivers.find((d) => d.id === favourites.driverId)?.team;
  const teamName = grid.teams.find((t) => t.id === favourites.teamId)?.name;

  return (
    <Section
      title="Favourites"
      description={`One driver and one team from the ${grid.season} grid.`}
      aside={<SaveNote state={state} />}
    >
      {grid.drivers.length === 0 ? (
        <p className="text-sm text-warm-400">
          The current grid couldn&apos;t be loaded just now. Refresh to try again.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="fav-driver" className="flex items-center gap-2 text-xs font-semibold text-warm-300 mb-2">
              <Swatch team={driverTeam} />
              Driver
            </label>
            <select
              id="fav-driver"
              disabled={!ready}
              value={favourites.driverId ?? ""}
              onChange={(event) => change({ driverId: event.target.value || null })}
              className={selectClass}
            >
              <option value="">No favourite</option>
              {grid.drivers.map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.name}
                  {driver.team ? ` — ${driver.team}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="fav-team" className="flex items-center gap-2 text-xs font-semibold text-warm-300 mb-2">
              <Swatch team={teamName} />
              Team
            </label>
            <select
              id="fav-team"
              disabled={!ready}
              value={favourites.teamId ?? ""}
              onChange={(event) => change({ teamId: event.target.value || null })}
              className={selectClass}
            >
              <option value="">No favourite</option>
              {grid.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {status === "error" && (
        <p className="text-xs text-error mt-3">Your saved favourites couldn&apos;t be loaded. Refresh to try again.</p>
      )}
    </Section>
  );
}

function Swatch({ team }: { team?: string }) {
  if (!team) return <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full bg-white/15" />;
  const { hex, glow } = getTeamColor(team);
  return (
    <span
      aria-hidden="true"
      className="w-2.5 h-2.5 rounded-full"
      style={{ background: hex, boxShadow: `0 0 8px ${glow}` }}
    />
  );
}

const CLOCK_LABELS: Record<ClockPreference, string> = {
  auto: "Automatic",
  "12h": "12-hour",
  "24h": "24-hour",
};

function PreferencesSection() {
  const { status, preferences, update } = usePreferences();
  const [state, setState] = useState<SaveState>("idle");
  const current = preferences.clock ?? "auto";

  async function choose(clock: ClockPreference) {
    setState("saving");
    setState((await update({ clock })) ? "saved" : "failed");
  }

  return (
    <Section
      title="Preferences"
      description="Saved to your account, so they follow you to any device you sign in on."
      aside={<SaveNote state={state} />}
    >
      <fieldset disabled={status !== "ready"}>
        <legend className="text-xs font-semibold text-warm-300 mb-2">Time format</legend>
        <div role="radiogroup" className="grid grid-cols-3 gap-2">
          {CLOCK_VALUES.map((value) => (
            <label
              key={value}
              className={`min-h-[44px] flex items-center justify-center rounded-xl border text-[13px] font-semibold cursor-pointer transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary ${
                current === value
                  ? "border-primary/60 bg-primary-container/15 text-on-background"
                  : "border-white/[0.12] text-warm-300 hover:bg-white/[0.04]"
              }`}
            >
              <input
                type="radio"
                name="clock"
                value={value}
                checked={current === value}
                onChange={() => choose(value)}
                className="sr-only"
              />
              {CLOCK_LABELS[value]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-warm-400 leading-relaxed mt-3">
        Automatic follows your device. Session times around the app will move
        over to this setting in an upcoming update; for now it is saved, not
        yet applied.
      </p>
    </Section>
  );
}

function SignInMethodsSection({
  email,
  providers,
  googleEnabled,
}: {
  email: string;
  providers: { providerId: string; accountId: string }[];
  googleEnabled: boolean;
}) {
  const router = useRouter();
  const googleAccount = providers.find((p) => p.providerId === "google");
  const hasGoogle = Boolean(googleAccount);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function linkGoogle() {
    setBusy(true);
    setMessage(null);
    const { error } = await authClient.linkSocial({
      provider: "google",
      callbackURL: "/account",
      errorCallbackURL: "/account",
    });
    if (error) {
      setBusy(false);
      setMessage("Google couldn't be linked just now. Please try again.");
    }
  }

  async function unlinkGoogle() {
    setBusy(true);
    setMessage(null);
    const { error } = await authClient.unlinkAccount({
      accountId: googleAccount?.accountId ?? "",
    });
    setBusy(false);
    if (error) {
      setMessage("Google couldn't be unlinked just now. Please try again.");
      return;
    }
    router.refresh();
  }

  return (
    <Section
      title="Sign-in methods"
      description="Ways you can sign in to this account."
    >
      <ul className="flex flex-col gap-2">
        <li className="flex items-center gap-3 rounded-xl border border-white/[0.08] px-4 py-3">
          <span className="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
            mail
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-on-background">Email link</span>
            <span className="block text-xs text-warm-400 truncate">{email} · always available</span>
          </span>
        </li>
        {(hasGoogle || googleEnabled) && (
          <li className="flex items-center gap-3 rounded-xl border border-white/[0.08] px-4 py-3">
            <span className="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
              account_circle
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-on-background">Google</span>
              <span className="block text-xs text-warm-400">
                {hasGoogle ? "Connected" : "Not connected"}
              </span>
            </span>
            {hasGoogle ? (
              <button
                type="button"
                onClick={unlinkGoogle}
                disabled={busy}
                className="min-h-[40px] px-3 rounded-lg text-xs font-semibold text-warm-300 hover:text-on-background hover:bg-white/[0.05] disabled:opacity-50"
              >
                Disconnect
              </button>
            ) : (
              <button
                type="button"
                onClick={linkGoogle}
                disabled={busy}
                className="min-h-[40px] px-3 rounded-lg border border-white/[0.14] text-xs font-semibold text-warm-100 hover:bg-white/[0.05] disabled:opacity-50"
              >
                Connect
              </button>
            )}
          </li>
        )}
      </ul>
      {message && <p role="alert" className="text-xs text-error mt-3">{message}</p>}
    </Section>
  );
}

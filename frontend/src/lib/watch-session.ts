"use client";

/**
 * The client half of paired watch mode — two screens replaying one race in step.
 *
 * `backend/app/watch_session.py` holds the shared state and the argument for why
 * it is a polled Mongo document rather than a peer connection. This file is the
 * consumer that argument was written for, and it carries the half of the design
 * that only exists on the client: **the wire never transports a playhead.**
 *
 * Both devices already have the whole race locally and run the same
 * deterministic clock over the same lap durations, so what crosses the network
 * is a command and an anchor — "playing, from lap 12 + 8.4s, as of this server
 * instant" — and each device works out its own current position from that. A
 * frame-by-frame position feed at 1.5s poll intervals would be visibly worse
 * than no sync at all: the follower would snap backwards every poll to wherever
 * the leader had been a second and a half ago.
 *
 * That anchor is also why nothing here reads `Date.now()` when deciding where to
 * be. `updated_at` and `server_now_ms` both come from the server in the same
 * response, so the elapsed-since-write subtraction is entirely in the server's
 * own clock. A phone whose clock is ten minutes out still lands in the right
 * place — and a phone whose clock is out is not hypothetical at a watch party,
 * it is the second most likely device in the room.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TimingMode } from "./watch-preferences";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

/** Matches `WatchState` in `backend/app/watch_session.py`, which rejects unknown
 * fields outright — so a field added on one side and not the other fails loudly
 * at the first write rather than being silently dropped. */
export interface WatchPartyState {
  lap_index: number;
  lap_elapsed_ms: number;
  playing: boolean;
  timing_mode: TimingMode;
  device: string;
}

export interface WatchSessionView {
  session_id: string;
  race_id: string | null;
  rev: number;
  state: Partial<WatchPartyState>;
  devices: number;
  expires_at: string | null;
  server_now_ms: number;
  updated_at: string | null;
  /** Present only for the device that owns the session; a joining device is
   * never told the code it just burned. */
  code?: string | null;
  code_expires_at?: string | null;
}

/* -------------------------------------------------------------------------- */
/* transport                                                                   */
/* -------------------------------------------------------------------------- */

export type WatchSessionFailure =
  | "unknown_code"
  | "unknown_session"
  | "rate_limited"
  | "disabled"
  | "offline";

export class WatchSessionError extends Error {
  readonly kind: WatchSessionFailure;
  /** Seconds, from the server's `Retry-After`. Only meaningful for
   * `rate_limited`. */
  readonly retryAfter: number;

  constructor(kind: WatchSessionFailure, message: string, retryAfter = 0) {
    super(message);
    this.name = "WatchSessionError";
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

/**
 * The pairing endpoints refuse in three distinguishable ways and the difference
 * matters to a person standing there with a phone: a mistyped code should say
 * so, a rate limit should say how long, and a disabled feature should not look
 * like a typo. A single "something went wrong" would make the first two
 * indistinguishable, and the mistyped code is by far the most common.
 */
async function call<T>(
  path: string,
  init: RequestInit & { query?: Record<string, string> } = {}
): Promise<T> {
  const url = new URL(path, API_BASE_URL);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      ...init,
      // Never cached: every one of these is either a mutation or a poll for
      // something that changed a moment ago.
      cache: "no-store",
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
    });
  } catch {
    throw new WatchSessionError("offline", "Couldn't reach the server.");
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (response.ok) return body as T;

  const error = String(body.error ?? "");
  if (response.status === 429) {
    const header = Number(response.headers.get("Retry-After"));
    const retry = Number(body.retry_after) || (Number.isFinite(header) ? header : 0);
    throw new WatchSessionError(
      "rate_limited",
      String(body.message ?? "Too many pairing attempts. Try again shortly."),
      Math.max(1, Math.round(retry))
    );
  }
  if (error === "watch_sessions_disabled") {
    throw new WatchSessionError("disabled", "Pairing is switched off right now.");
  }
  if (error === "unknown_code") {
    throw new WatchSessionError("unknown_code", "That code doesn't match a session.");
  }
  if (error === "unknown_session") {
    throw new WatchSessionError("unknown_session", "This party has ended.");
  }
  throw new WatchSessionError("offline", "The server couldn't handle that.");
}

export function createWatchSession(
  raceId: string,
  state: WatchPartyState
): Promise<WatchSessionView> {
  return call<WatchSessionView>("/api/watch_session", {
    method: "POST",
    body: JSON.stringify({ race_id: raceId, state }),
  });
}

export function joinWatchSession(code: string): Promise<WatchSessionView> {
  return call<WatchSessionView>("/api/watch_session/join", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export function readWatchSession(sessionId: string): Promise<WatchSessionView> {
  return call<WatchSessionView>("/api/watch_session", {
    method: "GET",
    query: { session_id: sessionId },
  });
}

export function publishWatchState(
  sessionId: string,
  state: WatchPartyState
): Promise<WatchSessionView> {
  return call<WatchSessionView>("/api/watch_session/state", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, state }),
  });
}

export function reissueWatchCode(sessionId: string): Promise<WatchSessionView> {
  return call<WatchSessionView>("/api/watch_session/code", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId }),
  });
}

export function endWatchSession(sessionId: string): Promise<{ ended: boolean }> {
  return call<{ ended: boolean }>("/api/watch_session/end", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId }),
  });
}

/* -------------------------------------------------------------------------- */
/* display + projection                                                        */
/* -------------------------------------------------------------------------- */

/** `ABCD2345` -> `ABCD 2345`. Grouped for reading aloud across a room, which is
 * how this code actually travels. `normalise_code` on the server strips the
 * space back out, so what is displayed can be pasted straight back. */
export function groupCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

export interface WatchPosition {
  lapIndex: number;
  elapsedMs: number;
  playing: boolean;
  timingMode: TimingMode | null;
}

/**
 * Where the other screen is *now*, from where it said it was *then*.
 *
 * The stored state is a snapshot with a timestamp, not a live position. If it
 * was playing when it was written, the race has moved on by exactly the wall
 * time since — both devices run the same durations, so that surplus is rolled
 * forward through the lap array here rather than guessed at. If it was paused,
 * nothing has moved and the snapshot is the answer.
 *
 * The roll-forward loop mirrors `RealTimeLapClock.frame` deliberately, including
 * the non-positive-duration guard: an array with a zero in it would otherwise
 * spin forever, and this runs on every poll that carries a new revision.
 */
export function projectPosition(
  view: WatchSessionView,
  durationsMs: number[]
): WatchPosition {
  const state = view.state ?? {};
  const playing = Boolean(state.playing);
  const timingMode =
    state.timing_mode === "interval" || state.timing_mode === "gap"
      ? state.timing_mode
      : null;

  const lastIndex = Math.max(0, durationsMs.length - 1);
  let index = Math.min(Math.max(0, Math.round(state.lap_index ?? 0)), lastIndex);
  let elapsed = Math.max(0, state.lap_elapsed_ms ?? 0);

  if (playing) {
    const written = view.updated_at ? Date.parse(view.updated_at) : NaN;
    if (Number.isFinite(written)) {
      elapsed += Math.max(0, view.server_now_ms - written);
    }
  }

  while (index < lastIndex) {
    const duration = durationsMs[index];
    if (!(duration > 0)) {
      index += 1;
      continue;
    }
    if (elapsed < duration) break;
    elapsed -= duration;
    index += 1;
  }

  return { lapIndex: index, elapsedMs: elapsed, playing, timingMode };
}

/* -------------------------------------------------------------------------- */
/* the hook                                                                    */
/* -------------------------------------------------------------------------- */

const POLL_MS = 1500;

const RESUME_KEY = "apex.watch.party";

/** A label, never a credential. Eight hex characters is enough for a device to
 * recognise its own echo in a party of at most eight, and the server's pattern
 * rejects anything that is not alphanumeric anyway. */
function newDeviceLabel(): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Survives a reload, and only a reload.
 *
 * Stored in `sessionStorage` rather than `localStorage` on purpose: this is a
 * capability for driving a screen, it should die with the tab, and it must not
 * leak into a second tab that happens to open the same race. The race id travels
 * with it so a resume can be refused when the tab has moved to a different
 * round — a session's state indexes *that* race's laps, and applying it to
 * another one would be a lap number pointing at the wrong race.
 *
 * A phone that drops out of a 90-minute party because someone pulled to refresh
 * is a bad enough experience to be worth this; a party that silently follows you
 * to an unrelated race would be worse than none.
 */
function readResume(raceId: string): string | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sessionId?: string; raceId?: string };
    if (!parsed.sessionId || parsed.raceId !== raceId) return null;
    return parsed.sessionId;
  } catch {
    return null;
  }
}

function writeResume(sessionId: string | null, raceId: string): void {
  try {
    if (sessionId) {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({ sessionId, raceId }));
    } else {
      sessionStorage.removeItem(RESUME_KEY);
    }
  } catch {
    // Private mode, or storage full. Losing the party on reload is a downgrade,
    // not a failure.
  }
}

export interface WatchPartyOptions {
  /** `"2026-1"`, matching the route and the server's `race_id` pattern. */
  raceId: string;
  /** The same array the clock runs on, used to roll a stale offset forward. */
  durationsMs: number[];
  /** This device's position right now, read at the moment of publishing. */
  readState: () => Omit<WatchPartyState, "device">;
  /** Put this device where the other one says it is. */
  applyState: (position: WatchPosition) => void;
}

export interface WatchParty {
  paired: boolean;
  /** Live pairing code, or null once it has been burned or has expired. */
  code: string | null;
  codeExpiresAt: string | null;
  devices: number;
  /** The race the party is watching, which is not necessarily the one this
   * device is on — a code typed from the wrong page is an ordinary mistake. */
  partyRaceId: string | null;
  busy: boolean;
  error: WatchSessionError | null;
  host: () => Promise<void>;
  join: (code: string) => Promise<WatchSessionView | null>;
  refreshCode: () => Promise<void>;
  leave: () => Promise<void>;
  /**
   * Publish this device's position. Called from user handlers only — never from
   * an effect watching playback state, which would echo forever: applying a
   * remote state changes exactly the values such an effect would watch, so the
   * two devices would trade writes until one of them closed the tab.
   *
   * `overrides` exists because React state is not readable in the handler that
   * sets it. A control that changes the timing mode calls
   * `setTimingModePreference` and then publishes in the same tick, at which
   * point `readState` still closes over the *old* mode — so the new value is
   * passed explicitly rather than published one interaction late.
   */
  publish: (overrides?: Partial<Omit<WatchPartyState, "device">>) => void;
  clearError: () => void;
}

export function useWatchParty({
  raceId,
  durationsMs,
  readState,
  applyState,
}: WatchPartyOptions): WatchParty {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null);
  const [devices, setDevices] = useState(1);
  const [partyRaceId, setPartyRaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WatchSessionError | null>(null);

  const deviceRef = useRef<string>("");
  if (!deviceRef.current) deviceRef.current = newDeviceLabel();

  // The callbacks and the durations change identity on most renders; the poll
  // loop must not restart every time one does, so it reads them through refs.
  const readRef = useRef(readState);
  const applyRef = useRef(applyState);
  const durationsRef = useRef(durationsMs);
  useEffect(() => {
    readRef.current = readState;
    applyRef.current = applyState;
    durationsRef.current = durationsMs;
  }, [readState, applyState, durationsMs]);

  /** The highest revision this device has either written or applied. Anything
   * above it came from the other screen; anything at or below it is our own echo
   * coming back, and applying that would fight the user's own input. */
  const seenRevRef = useRef(0);
  const sessionRef = useRef<string | null>(null);

  const adopt = useCallback(
    (view: WatchSessionView, { apply }: { apply: boolean }) => {
      sessionRef.current = view.session_id;
      setSessionId(view.session_id);
      setPartyRaceId(view.race_id);
      setDevices(view.devices);
      setCode(view.code ?? null);
      setCodeExpiresAt(view.code_expires_at ?? null);
      if (apply && view.rev > seenRevRef.current) {
        applyRef.current(projectPosition(view, durationsRef.current));
      }
      seenRevRef.current = Math.max(seenRevRef.current, view.rev);
    },
    []
  );

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (caught) {
      setError(
        caught instanceof WatchSessionError
          ? caught
          : new WatchSessionError("offline", "Something went wrong.")
      );
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const host = useCallback(async () => {
    await run(async () => {
      const view = await createWatchSession(raceId, {
        ...readRef.current(),
        device: deviceRef.current,
      });
      // Not applied: this device *is* the state that was just stored.
      adopt(view, { apply: false });
      writeResume(view.session_id, raceId);
      return view;
    });
  }, [adopt, raceId, run]);

  const join = useCallback(
    async (raw: string) => {
      return run(async () => {
        const view = await joinWatchSession(raw);
        // Applied unconditionally — matching the other screen is the entire
        // point of joining, and `seenRevRef` is still 0 here so the guard in
        // `adopt` cannot swallow it.
        adopt(view, { apply: true });
        // Stored against the *party's* race, not this device's: when the two
        // differ the caller navigates, and the resume has to survive that.
        writeResume(view.session_id, view.race_id ?? raceId);
        return view;
      });
    },
    [adopt, raceId, run]
  );

  const refreshCode = useCallback(async () => {
    const id = sessionRef.current;
    if (!id) return;
    await run(async () => {
      const view = await reissueWatchCode(id);
      adopt(view, { apply: false });
      return view;
    });
  }, [adopt, run]);

  const forget = useCallback(() => {
    sessionRef.current = null;
    seenRevRef.current = 0;
    setSessionId(null);
    setCode(null);
    setCodeExpiresAt(null);
    setDevices(1);
    setPartyRaceId(null);
    writeResume(null, raceId);
  }, [raceId]);

  const leave = useCallback(async () => {
    const id = sessionRef.current;
    forget();
    if (!id) return;
    // Deliberately not surfaced if it fails. The local party is already over —
    // reporting a server error for an unpair the user can see has happened would
    // be a lie about the thing in front of them. The TTL collects the document.
    try {
      await endWatchSession(id);
    } catch {
      /* the document expires on its own */
    }
  }, [forget]);

  const publish = useCallback((overrides?: Partial<Omit<WatchPartyState, "device">>) => {
    const id = sessionRef.current;
    if (!id) return;
    void publishWatchState(id, {
      ...readRef.current(),
      ...overrides,
      device: deviceRef.current,
    })
      .then((view) => {
        // Our own write. Recording the revision is what stops the next poll
        // reading it back and re-applying it on top of whatever the user has
        // done since.
        seenRevRef.current = Math.max(seenRevRef.current, view.rev);
        setDevices(view.devices);
      })
      .catch((caught) => {
        if (caught instanceof WatchSessionError && caught.kind === "unknown_session") {
          forget();
          setError(caught);
        }
        // Any other failure is a dropped command, not a broken party: the next
        // press publishes the position that matters anyway.
      });
  }, [forget]);

  /* ----------------------------- resume ----------------------------- */

  useEffect(() => {
    const stored = readResume(raceId);
    if (!stored) return;
    let cancelled = false;
    void readWatchSession(stored)
      .then((view) => {
        if (cancelled) return;
        adopt(view, { apply: true });
      })
      .catch(() => {
        // Expired or ended while the tab was reloading. Silent: the user did
        // not ask for a party this page load, so an error about one they can no
        // longer see would be noise.
        if (!cancelled) writeResume(null, raceId);
      });
    return () => {
      cancelled = true;
    };
  }, [adopt, raceId]);

  /* ------------------------------ poll ------------------------------ */

  useEffect(() => {
    if (!sessionId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const tick = async () => {
      // A backgrounded tab is not watching anything, and the wake lock means a
      // foregrounded one stays foregrounded. Skipping the request costs nothing
      // and the `visibilitychange` listener catches up immediately on return —
      // without it a phone in someone's pocket would poll for three hours.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        schedule();
        return;
      }
      try {
        const view = await readWatchSession(sessionId);
        if (cancelled) return;
        adopt(view, { apply: true });
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof WatchSessionError && caught.kind === "unknown_session") {
          forget();
          setError(caught);
          return;
        }
        // A transient network failure keeps polling. The party is not over
        // because one request out of forty a minute did not land.
      }
      schedule();
    };

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => void tick(), POLL_MS);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };

    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [adopt, forget, sessionId]);

  const clearError = useCallback(() => setError(null), []);

  return {
    paired: Boolean(sessionId),
    code,
    codeExpiresAt,
    devices,
    partyRaceId,
    busy,
    error,
    host,
    join,
    refreshCode,
    leave,
    publish,
    clearError,
  };
}

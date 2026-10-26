/**
 * The signed-in user's bearer token for the `f1-agent` service.
 *
 * The agent is a separate `*.run.app` origin, and `run.app` is on the Public
 * Suffix List, so it can never see this site's session cookie. Instead the
 * frontend mints a short-lived JWT server-side (`GET /api/agent-token`, owned by
 * the accounts work) and the browser sends it as `Authorization: Bearer …`.
 * The agent verifies it in `backend/agent/user_auth.py`, which documents the
 * claims; this module only fetches and caches it.
 *
 * The contract this module consumes:
 *
 *   200 {token, expiresAt}   signed in; the token lives ten minutes
 *   401                      signed out
 *
 * **Why cache at all.** Every chat turn and every history request needs the
 * token, and fetching it each time would put a same-origin round trip in front
 * of every one of them. So it is held in memory until {@link REFRESH_MARGIN_MS}
 * before it expires, then fetched again on the next call — which is what makes
 * an expiring token refresh silently rather than surfacing as a 401 halfway
 * through a conversation. Memory, not `localStorage`: a bearer credential has
 * no business outliving the tab, or being readable by every script that can
 * read storage.
 *
 * **Signed out is cached too, briefly.** A guest asking five questions would
 * otherwise pay five 401s. {@link SIGNED_OUT_TTL_MS} is short so that signing
 * in, in this tab or another, is noticed within a minute even without
 * {@link clearAgentToken} being called.
 *
 * **Concurrent callers share one request.** Opening the panel checks the
 * session and loads history at the same moment; without de-duplication that is
 * two identical token fetches racing each other.
 *
 * Failure posture: anything other than a 200 with a usable token resolves to
 * `null`, never throws. A null token means "guest", and guest is a fully
 * working mode — the agent answers, it just does not save — so a broken token
 * route must degrade to exactly that rather than break chat.
 */

export const TOKEN_ROUTE = "/api/agent-token";

/** Refetch this long before `expiresAt`, so a token is never sent in its last
 *  minute — long enough to cover a slow request and ordinary clock skew. */
export const REFRESH_MARGIN_MS = 60_000;

/** How long a 401 (or a missing route) is remembered as "signed out". */
export const SIGNED_OUT_TTL_MS = 60_000;

/**
 * Turn the route's `expiresAt` into epoch milliseconds.
 *
 * The contract names the field but not its encoding, so all three plausible
 * ones are accepted: an ISO string, epoch seconds, or epoch milliseconds (told
 * apart by magnitude — epoch seconds will not reach 1e12 until the year 33658).
 * If none parses, the token's own `exp` claim is read instead, since the agent
 * enforces that one regardless of what the route said.
 */
export function parseExpiry(expiresAt: unknown, token: string): number | null {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt >= 1e12 ? expiresAt : expiresAt * 1000;
  }
  if (typeof expiresAt === "string" && expiresAt.trim()) {
    const numeric = Number(expiresAt);
    if (Number.isFinite(numeric) && numeric > 0) return parseExpiry(numeric, token);
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return expiryFromJwt(token);
}

function expiryFromJwt(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

type Entry = { token: string | null; validUntilMs: number };

export interface AgentTokenCache {
  /** The current token, `null` when signed out. Pass `forceRefresh` after the
   *  agent rejected a token with 401 — the cached one is then known bad. */
  get(options?: { forceRefresh?: boolean }): Promise<string | null>;
  /** Forget everything — call on sign-in or sign-out. */
  clear(): void;
}

/**
 * A token cache over an injectable `fetch` and clock.
 *
 * Exported for the tests; the app uses the module-level instance behind
 * {@link getAgentToken}.
 */
export function createAgentTokenCache(deps: {
  fetch?: typeof fetch;
  now?: () => number;
} = {}): AgentTokenCache {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = deps.now ?? (() => Date.now());
  let entry: Entry | null = null;
  let inflight: Promise<string | null> | null = null;
  // Bumped by `clear()`, so a request that was already in flight when the
  // user signed out cannot land afterwards and resurrect their token.
  let generation = 0;

  async function load(): Promise<string | null> {
    const started = generation;
    let next: Entry | null;
    try {
      const res = await doFetch(TOKEN_ROUTE, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (res.status === 401 || res.status === 404) {
        // 404 is "the route is not deployed" — the same thing as signed out
        // from this module's point of view, and remembered just as long.
        next = { token: null, validUntilMs: now() + SIGNED_OUT_TTL_MS };
      } else if (!res.ok) {
        next = null;
      } else {
        const body = (await res.json()) as { token?: unknown; expiresAt?: unknown };
        const token = typeof body.token === "string" && body.token ? body.token : null;
        const expiry = token ? parseExpiry(body.expiresAt, token) : null;
        next =
          token && expiry !== null
            ? { token, validUntilMs: expiry - REFRESH_MARGIN_MS }
            : null;
      }
    } catch {
      // Offline, or a body that was not JSON. Not cached: the next call should
      // try again rather than wait out a TTL for a transient fault.
      next = null;
    }
    if (started !== generation) return null;
    entry = next;
    return next?.token ?? null;
  }

  return {
    get(options = {}) {
      if (!options.forceRefresh && entry && now() < entry.validUntilMs) {
        return Promise.resolve(entry.token);
      }
      if (options.forceRefresh) entry = null;
      if (!inflight) {
        inflight = load().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    clear() {
      generation += 1;
      entry = null;
      inflight = null;
    },
  };
}

const sharedCache = createAgentTokenCache();

/** The signed-in user's agent token, or `null` for a guest. Never throws. */
export function getAgentToken(options?: { forceRefresh?: boolean }): Promise<string | null> {
  return sharedCache.get(options);
}

/** Drop the cached token — on sign-in, sign-out, or account switch. */
export function clearAgentToken(): void {
  sharedCache.clear();
}

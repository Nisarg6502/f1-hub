import { describe, expect, it, vi } from "vitest";
import {
  createAgentTokenCache,
  parseExpiry,
  REFRESH_MARGIN_MS,
  SIGNED_OUT_TTL_MS,
  TOKEN_ROUTE,
} from "./agent-auth";

const T0 = Date.parse("2026-10-26T12:00:00Z");

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setup(responses: Array<() => Response | Promise<Response>>) {
  let clock = T0;
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  });
  const cache = createAgentTokenCache({
    fetch: fetchMock as unknown as typeof fetch,
    now: () => clock,
  });
  return {
    cache,
    fetchMock,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const signedIn = (token = "tok-1", minutes = 10) => () =>
  jsonResponse(200, { token, expiresAt: new Date(T0 + minutes * 60_000).toISOString() });

describe("getAgentToken cache", () => {
  it("fetches the token route once and serves the cached token after", async () => {
    const { cache, fetchMock } = setup([signedIn()]);
    expect(await cache.get()).toBe("tok-1");
    expect(await cache.get()).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(TOKEN_ROUTE);
  });

  it("refreshes silently a minute before expiry, not at it", async () => {
    const { cache, fetchMock, advance } = setup([signedIn("tok-1"), signedIn("tok-2", 20)]);
    await cache.get();
    advance(10 * 60_000 - REFRESH_MARGIN_MS - 1);
    expect(await cache.get()).toBe("tok-1");
    advance(2);
    expect(await cache.get()).toBe("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null on 401 and remembers it only briefly", async () => {
    const { cache, fetchMock, advance } = setup([
      () => jsonResponse(401),
      signedIn("after-sign-in", 30),
    ]);
    expect(await cache.get()).toBeNull();
    expect(await cache.get()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(SIGNED_OUT_TTL_MS);
    expect(await cache.get()).toBe("after-sign-in");
  });

  it("treats a missing route as signed out", async () => {
    const { cache } = setup([() => jsonResponse(404)]);
    expect(await cache.get()).toBeNull();
  });

  it("does not cache a network failure", async () => {
    const { cache, fetchMock } = setup([
      () => Promise.reject(new TypeError("Failed to fetch")),
      signedIn(),
    ]);
    expect(await cache.get()).toBeNull();
    expect(await cache.get()).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent callers", async () => {
    const { cache, fetchMock } = setup([signedIn()]);
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect([a, b]).toEqual(["tok-1", "tok-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forceRefresh replaces a token the agent rejected", async () => {
    const { cache } = setup([signedIn("stale"), signedIn("fresh")]);
    await cache.get();
    expect(await cache.get({ forceRefresh: true })).toBe("fresh");
  });

  it("clear() stops an in-flight fetch from resurrecting a signed-out token", async () => {
    let release: (r: Response) => void = () => {};
    const { cache } = setup([
      () => new Promise<Response>((resolve) => (release = resolve)),
      () => jsonResponse(401),
    ]);
    const pending = cache.get();
    cache.clear();
    release(signedIn("old-user")());
    expect(await pending).toBeNull();
    expect(await cache.get()).toBeNull();
  });
});

describe("parseExpiry", () => {
  it("accepts ISO strings, epoch seconds and epoch milliseconds", () => {
    expect(parseExpiry("2026-10-26T12:10:00Z", "x")).toBe(T0 + 600_000);
    expect(parseExpiry((T0 + 600_000) / 1000, "x")).toBe(T0 + 600_000);
    expect(parseExpiry(T0 + 600_000, "x")).toBe(T0 + 600_000);
  });

  it("falls back to the token's own exp claim", () => {
    const payload = btoa(JSON.stringify({ exp: (T0 + 600_000) / 1000 }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(parseExpiry(undefined, `h.${payload}.s`)).toBe(T0 + 600_000);
    expect(parseExpiry(undefined, "not-a-jwt")).toBeNull();
  });
});

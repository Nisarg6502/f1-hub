import { ImageResponse } from "next/og";
import type { ReactElement } from "react";
import { SHARE_FORMATS, type ShareFormat } from "@/lib/share";
import { loadCardFonts } from "./assets";

/**
 * Response helpers shared by every share route.
 *
 * The status codes are the contract, so they are spelled out once:
 *
 *   400 — the URL is wrong (bad season, unknown format). The caller's fault;
 *         retrying the same URL will fail the same way.
 *   404 — the URL is well formed and names nothing: a round that is not on
 *         that season's calendar, or a session with no classification yet.
 *   503 — the backend did not answer. Not a 500: nothing in *this* service is
 *         broken, and a 503 tells a crawler or a CDN to come back later
 *         rather than cache a failure.
 *
 * Errors are JSON with `no-store`, so a transient 503 is never cached in
 * place of the card it stood in for.
 */
export function shareError(status: 400 | 404 | 503, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Render a card element to PNG at `format`'s size, with the brand fonts.
 *
 * `ImageResponse` streams, which means a Satori failure would surface after
 * the 200 had been committed — as a truncated PNG with a success status.
 * Buffering the body here turns that into a thrown error the route can see,
 * at the cost of holding one ~100KB image in memory, and lets the response
 * carry a real `Content-Length`.
 */
export async function renderCard(
  element: ReactElement,
  format: ShareFormat,
  { cacheControl, filename }: { cacheControl: string; filename: string }
): Promise<Response> {
  let body: ArrayBuffer;
  try {
    const fonts = await loadCardFonts();
    const { width, height } = SHARE_FORMATS[format];
    const image = new ImageResponse(element, { width, height, fonts });
    body = await image.arrayBuffer();
  } catch (error) {
    // A Satori/resvg failure is ours, but it is still answered as the JSON
    // 503 rather than a bare 500: `no-store`, a stable shape for the share
    // sheet's error line, and a hint to crawlers to retry later.
    console.error("share card render failed", error);
    return shareError(503, "This card couldn't be drawn right now.");
  }
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(body.byteLength),
      "Cache-Control": cacheControl,
      // `inline`: the same URL is a link-preview image and an <img> source, and
      // `attachment` would make a browser download it on a plain visit. The
      // filename still applies when someone does save it.
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}

/* ==========================================================================
   Render memo
   ========================================================================== */

interface MemoEntry {
  expires: number;
  result: Promise<{ status: number; headers: [string, string][]; body: ArrayBuffer }>;
}

const MEMO_MAX = 64;
const MEMO_TTL_MS = 5 * 60 * 1000;
const memo = new Map<string, MemoEntry>();

/**
 * Serve a card from an in-process memo keyed by its *parsed* parameters.
 *
 * The CDN caches by URL; this caches by meaning, so two URLs that parse to
 * the same card (`?format=landscape` and no format at all) share one render,
 * and concurrent requests for one card share one in-flight render. Together
 * with `rejectUnknownParams` that bounds rendering work to the number of real
 * cards per five minutes, however many URLs are thrown at the routes.
 *
 * Only 200s are kept: an error is cheap to recompute and must not outlive
 * the backend hiccup that caused it. Five minutes matches the active-season
 * `Cache-Control`; past seasons simply re-render a little more often than
 * the CDN would. Small LRU (Map insertion order), per instance.
 */
export async function memoCard(key: string, produce: () => Promise<Response>): Promise<Response> {
  const now = Date.now();
  let entry = memo.get(key);
  if (!entry || entry.expires <= now) {
    const result = produce().then(async (res) => ({
      status: res.status,
      headers: [...res.headers.entries()],
      body: await res.arrayBuffer(),
    }));
    entry = { expires: now + MEMO_TTL_MS, result };
    memo.set(key, entry);
    result.then(
      (r) => { if (r.status !== 200) memo.delete(key); },
      () => memo.delete(key)
    );
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  } else {
    memo.delete(key);
    memo.set(key, entry);
  }
  const r = await entry.result;
  return new Response(r.body.slice(0), { status: r.status, headers: r.headers });
}

/** Test seam: forget every memoised card. */
export function clearCardMemo(): void {
  memo.clear();
}

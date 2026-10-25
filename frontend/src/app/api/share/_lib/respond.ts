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
  const fonts = await loadCardFonts();
  const { width, height } = SHARE_FORMATS[format];
  const image = new ImageResponse(element, { width, height, fonts });
  const body = await image.arrayBuffer();
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

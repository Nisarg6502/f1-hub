import { NextResponse } from "next/server";
import { getAllHiddenRounds } from "@/lib/spoilers-server";

/**
 * The rounds spoiler-free mode is hiding for THIS request's cookie.
 *
 * Exists so the settings panel's "hidden right now" list is computed by the
 * same server code, from the same cookie, as the placeholders on the page
 * behind it. The first version fetched the calendar from the browser and ran
 * the rules there, which had two problems: it could disagree with the server
 * about which rounds were hidden, and it depended on the backend's CORS
 * allowlist, so on any origin not on it (every local port but one) the list
 * silently read "Nothing hidden" while the page showed a placeholder.
 *
 * Same-origin, so the cookie rides along with no extra plumbing. Returns
 * names and round numbers only, never a result. `force-dynamic` because the
 * answer is per-visitor and per-minute.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const hidden = await getAllHiddenRounds();
    return NextResponse.json(
      { hidden },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return NextResponse.json(
      { error: "calendar_unavailable" },
      { status: 502, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { readUserDocuments } from "@/lib/auth-account-data";
import { buildAccountExport, exportFilename } from "@/lib/auth-export";

/**
 * `GET /api/me/export` — "Export my data", as a JSON file download.
 *
 * Reads the same collections the account deletion removes, so what you can
 * export is exactly what "Delete account" will erase. Credentials (session
 * tokens, OAuth tokens) are withheld from the file and marked as such; see
 * `lib/auth-export.ts` for why.
 *
 * A GET with `Content-Disposition: attachment`, so a plain link downloads
 * it: no client-side blob juggling, and it works with scripts disabled.
 * Cross-site reads are impossible — the session cookie is `SameSite=Lax`,
 * and even when a top-level navigation sends it, the response is a download
 * on the user's own machine, not something another origin can read.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "signed_out" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const docs = await readUserDocuments(user.id);
  const now = new Date();
  const body = buildAccountExport({
    user: docs.user ?? { id: user.id, email: user.email, name: user.name },
    accounts: docs.accounts,
    sessions: docs.sessions,
    preferences: docs.preferences,
    conversations: docs.conversations,
    now,
  });

  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(now)}"`,
      "Cache-Control": "no-store",
    },
  });
}

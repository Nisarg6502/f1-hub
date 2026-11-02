import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { deleteUserDocuments } from "@/lib/auth-account-data";

/**
 * `DELETE /api/me` — delete the signed-in account and everything stored
 * about it: the user, every session, every linked sign-in method, the
 * preferences document, and every chat conversation the agent saved under
 * this user id. The list is shared with the export so the two cannot drift;
 * see `lib/auth-account-data.ts`.
 *
 * Better Auth has its own delete endpoint, deliberately disabled in
 * `lib/auth.ts`: it knows about its own collections only, and would leave
 * preferences and chat history behind while reporting success.
 *
 * Guarded against cross-site requests by requiring a JSON body with an
 * explicit confirmation — a plain cross-site form or `<img>` cannot send
 * `DELETE` with `Content-Type: application/json`, and the session cookie is
 * `SameSite=Lax`, so it is not sent on a cross-site `fetch` either. The
 * confirmation field also means a stray `curl` or a misfired client call
 * cannot delete an account by accident.
 *
 * The response clears the session cookie names Better Auth uses, so the
 * browser is signed out at once rather than holding a cookie for a session
 * that no longer exists.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const SESSION_COOKIES = [
  "better-auth.session_token",
  "better-auth.session_data",
  "__Secure-better-auth.session_token",
  "__Secure-better-auth.session_data",
];

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "signed_out" }, { status: 401, headers: NO_STORE });
  }

  let confirmed = false;
  try {
    const body = (await request.json()) as { confirm?: unknown };
    confirmed = body?.confirm === "delete-my-account";
  } catch {
    confirmed = false;
  }
  if (!confirmed) {
    return NextResponse.json(
      { error: "confirmation_required", message: 'Send {"confirm":"delete-my-account"}' },
      { status: 400, headers: NO_STORE }
    );
  }

  const deleted = await deleteUserDocuments(user.id, user.email);
  const response = NextResponse.json({ deleted }, { headers: NO_STORE });
  for (const name of SESSION_COOKIES) {
    response.cookies.set(name, "", {
      path: "/",
      maxAge: 0,
      secure: name.startsWith("__Secure-"),
    });
  }
  return response;
}

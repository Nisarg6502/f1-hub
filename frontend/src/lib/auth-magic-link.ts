/**
 * Magic-link token hashing, shared by the auth config and the auth route.
 *
 * Better Auth stores each link's token in the verifications collection under
 * the identifier `magic-link:<stored token>` and, on verification, deletes
 * the row and refuses it in ONE step whether it was used before or merely
 * expired: both reach the sign-in page as `INVALID_TOKEN`. That collapses
 * the two cases a visitor most needs told apart — "you already used this"
 * versus "you waited too long, get a new one" — into one vague message.
 *
 * The auth route therefore looks the token up first. If a row exists and is
 * past its expiry, the link was real and simply expired, and the route sends
 * the visitor to `/signin?error=EXPIRED_TOKEN` itself. Doing that requires
 * computing the stored identifier from the raw token, which is why the
 * hasher lives here, under our control, rather than being the plugin's
 * internal "hashed" mode whose output format we would be guessing at.
 *
 * SHA-256, base64url without padding: a one-way hash is enough because the
 * token is 32 random characters (~190 bits), so there is nothing to brute
 * force and no need for a slow password hash.
 */

/** Five minutes is Better Auth's default and the right order of magnitude:
 *  long enough to switch to a mail app, short enough that a link sitting in
 *  an inbox is not a standing credential. Raised to ten because mail can be
 *  slow to arrive through some relays, and an expired link on first click is
 *  the worst sign-in experience there is. */
export const MAGIC_LINK_TTL_SECONDS = 10 * 60;

export async function hashMagicLinkToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function magicLinkIdentifier(storedToken: string): string {
  return `magic-link:${storedToken}`;
}

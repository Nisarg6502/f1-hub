import { SignJWT, jwtVerify, type JWTPayload } from "jose";

/**
 * The short-lived token that tells the `f1-agent` service which signed-in
 * user a chat request belongs to.
 *
 * Why a separate token at all, rather than the session cookie: the browser
 * calls the agent DIRECTLY and cross-site (`lib/agent-api.ts`), from this
 * origin to a different `*.run.app` host. The session cookie is scoped to this
 * origin and is `SameSite=Lax`, so it never reaches the agent — and it should
 * not: forwarding a long-lived session credential to a second service would
 * double the places it can leak from. Instead the frontend, which can read the
 * session, mints a narrow token on request (`GET /api/agent-token`) and the
 * agent verifies it with a shared secret.
 *
 * The contract with the chat-history work is fixed and must not drift:
 *   alg  HS256, keyed by env `AGENT_USER_TOKEN_SECRET`
 *   sub  the stable user id (the auth user's id, as a string)
 *   aud  "f1-agent"
 *   iss  "apex-frontend"
 *   iat  issue time
 *   exp  iat + 10 minutes
 *
 * Deliberately NO email and NO name. The agent needs to know whose
 * conversations to load and save, not who that person is, and a token that
 * carries no personal data is one whose leak — in a log line, a trace, a
 * crash report — discloses nothing beyond an opaque id. Ten minutes bounds
 * replay; the client simply asks for a new one.
 *
 * HS256 (a shared secret) rather than an asymmetric key pair because there is
 * exactly one verifier and we operate both ends; a JWKS endpoint and key
 * rotation machinery would be ceremony with no second party to serve.
 */

export const AGENT_TOKEN_AUDIENCE = "f1-agent";
export const AGENT_TOKEN_ISSUER = "apex-frontend";
export const AGENT_TOKEN_TTL_SECONDS = 10 * 60;

/**
 * HS256 is only as strong as its key. RFC 7518 §3.2 requires a key at least
 * as long as the hash output — 256 bits — so a shorter secret is refused
 * outright rather than producing tokens that merely look secure.
 */
export const AGENT_TOKEN_MIN_SECRET_BYTES = 32;

export interface AgentToken {
  token: string;
  /**
   * ISO-8601 instant at which the token stops verifying. A string rather than
   * a number so the unit is never in doubt: a bare number invites one side to
   * read seconds (as in the JWT's own `exp`) and the other milliseconds (as in
   * `Date.now()`), which is an off-by-1000 bug that only shows up as "every
   * token is already expired".
   */
  expiresAt: string;
}

function secretKey(secret: string): Uint8Array {
  const key = new TextEncoder().encode(secret);
  if (key.length < AGENT_TOKEN_MIN_SECRET_BYTES) {
    throw new Error(
      `AGENT_USER_TOKEN_SECRET must be at least ${AGENT_TOKEN_MIN_SECRET_BYTES} bytes`
    );
  }
  return key;
}

/**
 * Mint a token for `userId`. `now` is injectable so tests can pin the clock
 * instead of asserting on "roughly ten minutes from whenever this ran".
 */
export async function signAgentToken({
  userId,
  secret,
  now = Date.now(),
}: {
  userId: string;
  secret: string;
  now?: number;
}): Promise<AgentToken> {
  if (!userId) throw new Error("userId is required");
  const iat = Math.floor(now / 1000);
  const exp = iat + AGENT_TOKEN_TTL_SECONDS;

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setAudience(AGENT_TOKEN_AUDIENCE)
    .setIssuer(AGENT_TOKEN_ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKey(secret));

  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * The verifier the agent is expected to mirror, kept here so the tests prove
 * the minted token round-trips under exactly the checks the other side will
 * apply (algorithm pinned, audience and issuer required).
 */
export async function verifyAgentToken(
  token: string,
  secret: string,
  now: number = Date.now()
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    algorithms: ["HS256"],
    audience: AGENT_TOKEN_AUDIENCE,
    issuer: AGENT_TOKEN_ISSUER,
    currentDate: new Date(now),
  });
  return payload;
}

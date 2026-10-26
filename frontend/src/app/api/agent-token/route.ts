import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { signAgentToken } from "@/lib/auth-agent-token";

/**
 * `GET /api/agent-token` — a ten-minute token naming the signed-in user to
 * the `f1-agent` service. The claims, algorithm and lifetime are a contract
 * with the chat-history work; see `lib/auth-agent-token.ts`.
 *
 *   signed in   200 {token, expiresAt}
 *   signed out  401
 *
 * `no-store` on every response, success and failure alike: a cached 200
 * would hand one person's token to the next request through any shared
 * cache, and a cached 401 would keep a person who just signed in looking
 * signed out to the agent.
 *
 * A missing `AGENT_USER_TOKEN_SECRET` is a 503, not a 500 — the account
 * works, the agent link is simply not configured — and the chat falls back
 * to anonymous use, exactly as it behaves today.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "signed_out" }, { status: 401, headers: NO_STORE });
  }

  const secret = process.env.AGENT_USER_TOKEN_SECRET;
  if (!secret) {
    console.error("AGENT_USER_TOKEN_SECRET is not set; cannot mint agent tokens");
    return NextResponse.json(
      { error: "agent_token_unconfigured" },
      { status: 503, headers: NO_STORE }
    );
  }

  const minted = await signAgentToken({ userId: user.id, secret });
  return NextResponse.json(minted, { headers: NO_STORE });
}

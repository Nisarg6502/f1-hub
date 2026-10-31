"""Mint a test bearer token for the agent's saved-history endpoints.

TEST-ONLY. In production the token is minted by the frontend's
`GET /api/agent-token` route for a signed-in session (see
`agent/user_auth.py` for the contract). This script exists so the agent can be
exercised locally — curl, the end-to-end browser run — before or without that
route, using the same claims and the same shared secret. It is a script, not
an endpoint, so there is nothing here that could ever ship in an image's
request path.

    cd backend
    AGENT_USER_TOKEN_SECRET=... python scripts/mint_agent_token.py --sub test-user-1

Prints the token (and, with --json, the `{token, expiresAt}` body the real
route returns) to stdout. Reads the secret from the environment only; never
pass it on the command line, where it lands in shell history.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time

import jwt


def mint(sub: str, secret: str, ttl: int = 600) -> tuple[str, int]:
    now = int(time.time())
    claims = {"sub": sub, "aud": "f1-agent", "iss": "apex-frontend", "iat": now, "exp": now + ttl}
    return jwt.encode(claims, secret, algorithm="HS256"), now + ttl


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sub", default="test-user-1", help="user id to put in the token")
    parser.add_argument("--ttl", type=int, default=600, help="lifetime in seconds (contract: 600)")
    parser.add_argument("--json", action="store_true", help="print the /api/agent-token response body")
    args = parser.parse_args()

    secret = os.getenv("AGENT_USER_TOKEN_SECRET")
    if not secret:
        print("AGENT_USER_TOKEN_SECRET is not set", file=sys.stderr)
        return 2
    token, exp = mint(args.sub, secret, args.ttl)
    if args.json:
        expires = datetime.datetime.fromtimestamp(exp, datetime.timezone.utc).isoformat()
        print(json.dumps({"token": token, "expiresAt": expires.replace("+00:00", "Z")}))
    else:
        print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

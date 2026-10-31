import { describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  AGENT_TOKEN_AUDIENCE,
  AGENT_TOKEN_ISSUER,
  AGENT_TOKEN_TTL_SECONDS,
  signAgentToken,
  verifyAgentToken,
} from "./auth-agent-token";

const SECRET = "test-secret-that-is-at-least-32-bytes-long!!";
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0); // 2026-10-26T12:00:00Z

describe("signAgentToken", () => {
  it("signs HS256 with exactly the contracted claims", async () => {
    const { token } = await signAgentToken({ userId: "671c0ffee", secret: SECRET, now: NOW });

    expect(decodeProtectedHeader(token)).toEqual({ alg: "HS256", typ: "JWT" });

    const claims = decodeJwt(token);
    expect(claims).toEqual({
      sub: "671c0ffee",
      aud: "f1-agent",
      iss: "apex-frontend",
      iat: NOW / 1000,
      exp: NOW / 1000 + 600,
    });
  });

  it("carries no personal data", async () => {
    const { token } = await signAgentToken({ userId: "u1", secret: SECRET, now: NOW });
    const claims = decodeJwt(token);
    for (const key of ["email", "name", "picture", "image"]) {
      expect(claims).not.toHaveProperty(key);
    }
  });

  it("reports expiresAt as the ISO form of exp", async () => {
    const { token, expiresAt } = await signAgentToken({ userId: "u1", secret: SECRET, now: NOW });
    expect(expiresAt).toBe("2026-10-26T12:10:00.000Z");
    expect(Date.parse(expiresAt) / 1000).toBe(decodeJwt(token).exp);
    expect(AGENT_TOKEN_TTL_SECONDS).toBe(600);
  });

  it("floors sub-second clocks rather than rounding iat into the future", async () => {
    const { token } = await signAgentToken({ userId: "u1", secret: SECRET, now: NOW + 999 });
    expect(decodeJwt(token).iat).toBe(NOW / 1000);
  });

  it("refuses a secret shorter than 256 bits", async () => {
    await expect(
      signAgentToken({ userId: "u1", secret: "short", now: NOW })
    ).rejects.toThrow(/at least 32 bytes/);
  });

  it("refuses an empty user id", async () => {
    await expect(signAgentToken({ userId: "", secret: SECRET })).rejects.toThrow();
  });
});

describe("verifyAgentToken", () => {
  it("round-trips under the agent's checks until exp", async () => {
    const { token } = await signAgentToken({ userId: "u1", secret: SECRET, now: NOW });
    const payload = await verifyAgentToken(token, SECRET, NOW + 599_000);
    expect(payload.sub).toBe("u1");
    expect(payload.aud).toBe(AGENT_TOKEN_AUDIENCE);
    expect(payload.iss).toBe(AGENT_TOKEN_ISSUER);
  });

  it("rejects the token once ten minutes have passed", async () => {
    const { token } = await signAgentToken({ userId: "u1", secret: SECRET, now: NOW });
    await expect(verifyAgentToken(token, SECRET, NOW + 600_000)).rejects.toThrow(/exp/);
  });

  it("rejects a token signed with another secret", async () => {
    const { token } = await signAgentToken({ userId: "u1", secret: SECRET, now: NOW });
    await expect(
      verifyAgentToken(token, "another-secret-that-is-32-bytes-long!!!", NOW)
    ).rejects.toThrow();
  });
});

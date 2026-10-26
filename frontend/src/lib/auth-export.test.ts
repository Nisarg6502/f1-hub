import { describe, expect, it } from "vitest";
import { buildAccountExport, exportFilename } from "./auth-export";

/** Stands in for a driver ObjectId without importing the driver. */
const oid = (hex: string) => ({ toHexString: () => hex });

const NOW = new Date("2026-10-26T12:00:00.000Z");

describe("buildAccountExport", () => {
  const exported = buildAccountExport({
    now: NOW,
    user: {
      _id: oid("u1"),
      name: "Lando Fan",
      email: "fan@example.com",
      image: null,
      emailVerified: true,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    },
    accounts: [
      {
        _id: oid("a1"),
        userId: oid("u1"),
        providerId: "google",
        accountId: "1234",
        accessToken: "ya29.secret",
        refreshToken: "1//secret",
        idToken: "eyJ.secret",
        scope: "openid email profile",
      },
    ],
    sessions: [
      {
        _id: oid("s1"),
        userId: oid("u1"),
        token: "session-bearer-secret",
        userAgent: "Chrome",
        expiresAt: new Date("2026-11-25T00:00:00.000Z"),
      },
    ],
    preferences: { _id: oid("p1"), userId: "u1", clock: "24h", internal: 1 },
    conversations: [{ _id: oid("c1"), user_id: "u1", title: "Who won Monza?" }],
  });

  it("is versioned and dated", () => {
    expect(exported.format).toBe("apex-account-export");
    expect(exported.version).toBe(1);
    expect(exported.exportedAt).toBe("2026-10-26T12:00:00.000Z");
  });

  it("flattens ObjectIds and Dates and renames _id to id", () => {
    expect(exported.user).toEqual({
      id: "u1",
      name: "Lando Fan",
      email: "fan@example.com",
      image: null,
      emailVerified: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(exported.chatConversations).toEqual([
      { id: "c1", user_id: "u1", title: "Who won Monza?" },
    ]);
  });

  it("withholds every credential while saying it existed", () => {
    const [account] = exported.signInMethods;
    expect(account.accessToken).toBe("[withheld: credential]");
    expect(account.refreshToken).toBe("[withheld: credential]");
    expect(account.idToken).toBe("[withheld: credential]");
    expect(account.scope).toBe("openid email profile");
    expect(exported.sessions[0].token).toBe("[withheld: credential]");

    const serialised = JSON.stringify(exported);
    for (const secret of ["ya29.secret", "1//secret", "eyJ.secret", "session-bearer-secret"]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("exposes preferences through the public projection only", () => {
    expect(exported.preferences).toEqual({ clock: "24h" });
  });

  it("is JSON round-trippable", () => {
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
  });
});

describe("exportFilename", () => {
  it("is dated", () => {
    expect(exportFilename(NOW)).toBe("apex-account-2026-10-26.json");
  });
});

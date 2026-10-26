import "server-only";
import { headers } from "next/headers";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { magicLink } from "better-auth/plugins/magic-link";
import { nextCookies } from "better-auth/next-js";
import { APIError } from "better-auth/api";
import { AUTH_COLLECTIONS, getAuthDb, getMongoClient, isAuthConfigured } from "./auth-db";
import { deliverMagicLink, renderMagicLinkEmail } from "./auth-email";
import { hashMagicLinkToken, MAGIC_LINK_TTL_SECONDS } from "./auth-magic-link";

/**
 * Accounts, built on Better Auth.
 *
 * WHY BETTER AUTH, not Auth.js v5: Auth.js v5 never left beta
 * (`next-auth@5.0.0-beta.*` is still the only v5 on npm) and its maintainers
 * joined Better Auth in 2025, which now carries the recommendation for new
 * projects. Concretely, for what this app needs, Better Auth ships all of it
 * first-party — a MongoDB adapter, Google, a magic-link plugin, account
 * linking, server-side session reads in route handlers — and keeps sessions
 * in the database rather than in a JWT cookie, so "Delete account" and "Sign
 * out" revoke access immediately instead of waiting for a token to expire.
 *
 * THE PRINCIPLE this is configured around: nothing that works today goes
 * behind a login. Accounts only ADD things (synced preferences, favourites,
 * chat history). So every entry point checks `isAuthConfigured()` and hides
 * itself when the deployment has no database URI or secret — a build without
 * the secrets attached is the site exactly as it was.
 *
 * Built lazily (`getAuth()`) for the same reason the Mongo client is: `next
 * build` imports this module with no runtime secrets present.
 *
 * Environment:
 *   MONGODB_URI            required — same Atlas cluster as the backend
 *   BETTER_AUTH_SECRET     required — signs session cookies and encrypts
 *                          stored OAuth tokens (32+ random bytes)
 *   BETTER_AUTH_URL        the public origin, e.g. http://localhost:3105
 *   AUTH_MONGODB_DB        optional, defaults to f1_scratch
 *   GOOGLE_CLIENT_ID/_SECRET  optional; the Google button hides without them
 *   EMAIL_SERVER_* / EMAIL_FROM  SMTP for magic links (production only;
 *                          development prints the link instead — see
 *                          auth-email.ts)
 */

/** Session lifetime. Thirty days, refreshed at most daily while in use. */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const SESSION_REFRESH_SECONDS = 60 * 60 * 24;

export function isGoogleConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function siteUrl(): string {
  return process.env.BETTER_AUTH_URL || "http://localhost:3105";
}

/**
 * Per-address throttle on sending links, on top of Better Auth's per-IP
 * limit (5 per minute on the magic-link routes).
 *
 * The IP limit alone does not stop someone rotating addresses from mailing
 * one victim over and over — and every one of those messages is sent from
 * our SMTP account, so the damage lands on us too: Gmail suspends a sender
 * that blows through its daily quota. Five links per address per fifteen
 * minutes is far more than a person retrying ever needs.
 *
 * Records are keyed by the lower-cased address and expire through a TTL
 * index after an hour, so this collection never becomes a list of everyone
 * who has ever typed an email here.
 */
const SEND_WINDOW_MS = 15 * 60 * 1000;
const SEND_MAX_PER_WINDOW = 5;
let sendIndexReady: Promise<unknown> | null = null;

async function throttleMagicLinkSend(email: string): Promise<void> {
  const collection = getAuthDb().collection(AUTH_COLLECTIONS.magicLinkSends);
  sendIndexReady ??= collection
    .createIndex({ sentAt: 1 }, { expireAfterSeconds: 60 * 60 })
    .catch(() => {
      sendIndexReady = null;
    });
  await sendIndexReady;

  const address = email.trim().toLowerCase();
  const recent = await collection.countDocuments({
    email: address,
    sentAt: { $gt: new Date(Date.now() - SEND_WINDOW_MS) },
  });
  if (recent >= SEND_MAX_PER_WINDOW) {
    throw new APIError("TOO_MANY_REQUESTS", {
      message: "Too many sign-in links for this address. Wait a few minutes and try again.",
    });
  }
  await collection.insertOne({ email: address, sentAt: new Date() });
}

function createAuth() {
  const google = isGoogleConfigured()
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID as string,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
          // Always show the account chooser: on a shared machine, silently
          // signing in as whichever Google account is active is a surprise.
          prompt: "select_account" as const,
        },
      }
    : undefined;

  return betterAuth({
    appName: "APEX",
    baseURL: siteUrl(),
    secret: process.env.BETTER_AUTH_SECRET,
    database: mongodbAdapter(getAuthDb(), { client: getMongoClient() }),
    user: {
      modelName: AUTH_COLLECTIONS.users,
      // Deletion goes through our own `DELETE /api/me`, which also removes
      // preferences and chat conversations; Better Auth's endpoint would
      // leave those behind.
      deleteUser: { enabled: false },
    },
    session: {
      modelName: AUTH_COLLECTIONS.sessions,
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
    },
    account: {
      modelName: AUTH_COLLECTIONS.accounts,
      // Google tokens are not used for anything after sign-in, but they are
      // stored; encrypting them means a database leak does not also leak
      // working Google credentials.
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // Google vouches for its addresses (`email_verified`), so a Google
        // sign-in with the same address as an email-link account joins that
        // account instead of failing or creating a duplicate.
        trustedProviders: ["google"],
        // An email link is always available to every account (it needs no
        // stored credential), so unlinking Google can never lock anyone out.
        allowUnlinkingAll: true,
      },
    },
    verification: { modelName: AUTH_COLLECTIONS.verifications },
    socialProviders: google,
    rateLimit: {
      // On in every environment, so the limit is exercised in testing rather
      // than discovered in production. "database" storage because Cloud Run
      // runs several instances and an in-memory counter is per instance.
      enabled: true,
      storage: "database",
      modelName: AUTH_COLLECTIONS.rateLimits,
    },
    advanced: {
      // Cloud Run's front end sets X-Forwarded-For; without this every
      // visitor would share the load balancer's address and one rate-limit
      // bucket.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    databaseHooks: {
      user: {
        create: {
          // An email-link sign-up has no name. Start from the address's local
          // part so the header has something to show; it is editable on
          // /account.
          before: async (user) => {
            if (user.name && user.name.trim()) return { data: user };
            const local = String(user.email ?? "").split("@")[0] || "APEX fan";
            return { data: { ...user, name: local.slice(0, 60) } };
          },
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        // Hashed at rest, so a read of the verifications collection does not
        // yield links that work. The hasher is ours (not the plugin's
        // built-in "hashed" mode) because the auth route also needs it to
        // recognise an EXPIRED link and say so; see auth-magic-link.ts.
        storeToken: { type: "custom-hasher", hash: hashMagicLinkToken },
        sendMagicLink: async ({ email, url }) => {
          await throttleMagicLinkSend(email);
          const message = renderMagicLinkEmail({
            url,
            email,
            expiresInMinutes: Math.round(MAGIC_LINK_TTL_SECONDS / 60),
            siteUrl: siteUrl(),
          });
          await deliverMagicLink(email, message, url);
        },
      }),
      // Must stay last: lets server actions and route handlers set cookies.
      nextCookies(),
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;
const g = globalThis as typeof globalThis & { __apexAuth?: Auth };

/** The Better Auth instance. Throws if accounts are not configured. */
export function getAuth(): Auth {
  if (!isAuthConfigured()) throw new Error("Accounts are not configured");
  g.__apexAuth ??= createAuth();
  return g.__apexAuth;
}

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
};

/**
 * The signed-in user for the current request, or `null` — including when
 * accounts are not configured at all, so callers have one "not signed in"
 * path rather than two.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  if (!isAuthConfigured()) return null;
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const { id, name, email, image } = session.user;
  return { id, name, email, image };
}

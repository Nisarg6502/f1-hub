import "server-only";
import { MongoClient, ObjectId, type Db } from "mongodb";

/**
 * MongoDB access for accounts: one client per server process, opened lazily.
 *
 * LAZY because `next build` imports route modules to collect their config,
 * and the build environment (Cloud Build) has no `MONGODB_URI` — it is a
 * runtime secret on the Cloud Run service. Constructing the client at import
 * time would either throw during the build or bake a half-configured client
 * into it. Nothing here runs until a request needs the database.
 *
 * CACHED ON `globalThis` because `next dev` re-evaluates modules on every
 * edit, and a module-level client would leak one connection pool per save
 * until Atlas's free-tier connection cap starts refusing everyone.
 *
 * The database name is `AUTH_MONGODB_DB`, defaulting to `f1_scratch` — the
 * same database the backend and agent use, so the agent's
 * `agent_conversations` and these collections sit side by side and an
 * account deletion can reach both. Local testing sets `f1_scratch_dev` so
 * throwaway test users never land in production data.
 */

/**
 * Collection names. Prefixed `auth_` because `f1_scratch` is a shared
 * database full of race data, and Better Auth's defaults (`user`, `session`,
 * `account`, `verification`) would sit among `races` and `drivers` looking
 * like F1 entities. `agent_conversations` is owned by the agent service.
 */
export const AUTH_COLLECTIONS = {
  users: "auth_users",
  sessions: "auth_sessions",
  accounts: "auth_accounts",
  verifications: "auth_verifications",
  rateLimits: "auth_rate_limits",
  magicLinkSends: "auth_magic_link_sends",
  preferences: "user_preferences",
  conversations: "agent_conversations",
} as const;

const DEFAULT_DB = "f1_scratch";

type MongoGlobal = typeof globalThis & { __apexAuthMongo?: MongoClient };

/**
 * Whether accounts can work in this process at all. Without a database URI
 * or a signing secret there is nothing to sign in TO, and every account
 * surface hides itself rather than offering a button that fails — the
 * deployment before the secrets are attached must look exactly like the
 * site does today.
 */
export function isAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.MONGODB_URI && env.BETTER_AUTH_SECRET);
}

export function getMongoClient(): MongoClient {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const g = globalThis as MongoGlobal;
  if (!g.__apexAuthMongo) {
    g.__apexAuthMongo = new MongoClient(uri, {
      // Cloud Run scales to zero and a cold start should not hold a large
      // pool open against a free-tier cluster.
      maxPoolSize: 5,
      appName: "apex-frontend-auth",
    });
  }
  return g.__apexAuthMongo;
}

export function getAuthDb(): Db {
  return getMongoClient().db(process.env.AUTH_MONGODB_DB || DEFAULT_DB);
}

/**
 * Every form a user id may be stored in.
 *
 * Better Auth's Mongo adapter stores `_id` and the `userId` foreign keys as
 * ObjectIds, while everything written against the id string — preferences
 * here, `user_id` in the agent's conversations, which arrives as the JWT
 * `sub` — stores a string. A deletion that matched only one form would
 * report success and leave the other behind, which is the one bug an
 * account deletion must not have. So every query by user matches both.
 */
export function userIdForms(userId: string): (string | ObjectId)[] {
  return ObjectId.isValid(userId) && new ObjectId(userId).toHexString() === userId
    ? [userId, new ObjectId(userId)]
    : [userId];
}

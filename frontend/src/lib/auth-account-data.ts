import "server-only";
import { AUTH_COLLECTIONS, getAuthDb, userIdForms } from "./auth-db";

/**
 * Everything stored about one user, found the same way for export and for
 * deletion.
 *
 * Export and delete MUST walk the same list. If they were written separately,
 * the first collection added later to one and not the other would make the
 * privacy page false in one of two ways: data that is deleted but was never
 * disclosed in the export, or — worse — data that is exported, so plainly
 * stored, and then survives "Delete account". One function enumerating the
 * user's documents, used by both, makes that drift impossible to write.
 *
 * `auth_rate_limits` is not here: its keys are IP addresses and paths, not
 * user ids, and its rows expire within a minute. `auth_magic_link_sends` is
 * keyed by email and removed on deletion for completeness; its rows expire
 * within the hour regardless. `auth_verifications` rows for this address
 * (unused sign-in links, ten-minute lifetime) are removed on deletion too.
 */

export interface UserDocuments {
  user: Record<string, unknown> | null;
  accounts: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  preferences: Record<string, unknown> | null;
  conversations: Record<string, unknown>[];
}

function userFilter(userId: string) {
  return { $in: userIdForms(userId) };
}

export async function readUserDocuments(userId: string): Promise<UserDocuments> {
  const db = getAuthDb();
  const ids = userFilter(userId);
  const [user, accounts, sessions, preferences, conversations] = await Promise.all([
    db.collection(AUTH_COLLECTIONS.users).findOne({ _id: ids } as never),
    db.collection(AUTH_COLLECTIONS.accounts).find({ userId: ids }).toArray(),
    db.collection(AUTH_COLLECTIONS.sessions).find({ userId: ids }).toArray(),
    db.collection(AUTH_COLLECTIONS.preferences).findOne({ userId: ids }),
    db.collection(AUTH_COLLECTIONS.conversations).find({ user_id: ids }).toArray(),
  ]);
  return { user, accounts, sessions, preferences, conversations };
}

export interface DeletionReport {
  users: number;
  sessions: number;
  accounts: number;
  preferences: number;
  conversations: number;
  verifications: number;
  magicLinkSends: number;
}

/**
 * Remove every document belonging to `userId`. Sessions go FIRST, so that if
 * anything below fails part-way the person is at least signed out
 * everywhere, and a retry from a fresh sign-in finishes the job; the user
 * document goes LAST, so a half-finished deletion still has an account to
 * sign back into and retry from rather than orphaned data with no owner.
 */
export async function deleteUserDocuments(
  userId: string,
  email: string
): Promise<DeletionReport> {
  const db = getAuthDb();
  const ids = userFilter(userId);
  const address = email.trim().toLowerCase();

  const sessions = await db.collection(AUTH_COLLECTIONS.sessions).deleteMany({ userId: ids });
  const accounts = await db.collection(AUTH_COLLECTIONS.accounts).deleteMany({ userId: ids });
  const preferences = await db
    .collection(AUTH_COLLECTIONS.preferences)
    .deleteMany({ userId: ids });
  const conversations = await db
    .collection(AUTH_COLLECTIONS.conversations)
    .deleteMany({ user_id: ids });
  // Pending sign-in links store the address inside a JSON string `value`.
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const verifications = await db.collection(AUTH_COLLECTIONS.verifications).deleteMany({
    identifier: { $regex: "^magic-link:" },
    value: { $regex: `"email":"${escaped}"`, $options: "i" },
  });
  const magicLinkSends = await db
    .collection(AUTH_COLLECTIONS.magicLinkSends)
    .deleteMany({ email: address });
  const users = await db
    .collection(AUTH_COLLECTIONS.users)
    .deleteMany({ _id: ids } as never);

  return {
    users: users.deletedCount,
    sessions: sessions.deletedCount,
    accounts: accounts.deletedCount,
    preferences: preferences.deletedCount,
    conversations: conversations.deletedCount,
    verifications: verifications.deletedCount,
    magicLinkSends: magicLinkSends.deletedCount,
  };
}


import { pickPreferences, type Preferences } from "./preferences";

/**
 * The shape of "Export my data".
 *
 * The promise on the privacy page is "everything stored about you", so the
 * export is built by reading every collection that holds a user's documents —
 * not by re-serialising whatever the account page happens to display. What
 * this module adds is the opposite discipline: it removes the handful of
 * fields that are CREDENTIALS rather than data about the person.
 *
 *   - session `token`: the live bearer value behind the session cookie.
 *     Writing it into a file that ends up in a Downloads folder or an email
 *     attachment would hand anyone holding the file a signed-in session.
 *   - account `accessToken` / `refreshToken` / `idToken`: Google OAuth
 *     credentials. Same reasoning, with a longer blast radius — a refresh
 *     token outlives the session.
 *   - account `password`: never set (there are no passwords here), stripped
 *     anyway so a future credential provider cannot leak through this path.
 *
 * Each stripped field is replaced by a note saying it existed and was
 * withheld, so the export is honest about what is stored even where it does
 * not reproduce it.
 *
 * Pure (Mongo documents in, a plain object out) so the shape is testable
 * without a database.
 */

export const EXPORT_FORMAT_VERSION = 1;

const SESSION_SECRETS = ["token"] as const;
const ACCOUNT_SECRETS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "password",
] as const;

const WITHHELD = "[withheld: credential]";

type Doc = Record<string, unknown>;

/**
 * Mongo documents carry `ObjectId`s and `Date`s. `JSON.stringify` would
 * render an ObjectId as an object of internals in some driver versions, so
 * anything with a `toHexString` is flattened to its hex id, and Dates to ISO
 * strings, before the document leaves this module.
 */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "object" &&
    typeof (value as { toHexString?: unknown }).toHexString === "function"
  ) {
    return (value as { toHexString: () => string }).toHexString();
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object") {
    const out: Doc = {};
    for (const [key, inner] of Object.entries(value as Doc)) {
      out[key === "_id" ? "id" : key] = plain(inner);
    }
    return out;
  }
  return value;
}

function withhold(doc: Doc, fields: readonly string[]): Doc {
  const out = plain(doc) as Doc;
  for (const field of fields) {
    if (out[field] !== undefined && out[field] !== null) out[field] = WITHHELD;
  }
  return out;
}

export interface ExportSources {
  user: Doc;
  accounts: Doc[];
  sessions: Doc[];
  preferences: Doc | null;
  conversations: Doc[];
  now?: Date;
}

export interface AccountExport {
  format: "apex-account-export";
  version: number;
  exportedAt: string;
  user: Doc;
  signInMethods: Doc[];
  sessions: Doc[];
  preferences: Preferences;
  chatConversations: Doc[];
}

export function buildAccountExport({
  user,
  accounts,
  sessions,
  preferences,
  conversations,
  now = new Date(),
}: ExportSources): AccountExport {
  return {
    format: "apex-account-export",
    version: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    user: plain(user) as Doc,
    signInMethods: accounts.map((account) => withhold(account, ACCOUNT_SECRETS)),
    sessions: sessions.map((session) => withhold(session, SESSION_SECRETS)),
    preferences: pickPreferences(preferences),
    chatConversations: conversations.map((conversation) => plain(conversation) as Doc),
  };
}

/** `apex-account-2026-10-26.json` — dated so repeated exports do not collide. */
export function exportFilename(now: Date = new Date()): string {
  return `apex-account-${now.toISOString().slice(0, 10)}.json`;
}

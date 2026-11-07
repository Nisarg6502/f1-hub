import "server-only";
import { MongoServerError } from "mongodb";
import { AUTH_COLLECTIONS, getAuthDb } from "./auth-db";
import {
  pickReminderSettings,
  type ReminderSettings,
  type ReminderStore,
  type ReminderSubscription,
  type SendKey,
} from "./reminders";

/**
 * Mongo side of email reminders.
 *
 *   reminder_subscriptions  one document per user (unique `userId`, the id
 *                           STRING, like `user_preferences`): the settings
 *                           plus the address to send to.
 *   reminder_sends          one document per (user, session, lead), unique —
 *                           the dedupe ledger `dispatchReminders` claims
 *                           before every send. Expires after 60 days: only a
 *                           session that has not started can be due, so an
 *                           old row protects nothing.
 *
 * A separate collection, not a key in `user_preferences`: the dispatcher has
 * to find every opted-in user across all accounts, which wants its own
 * indexed `enabled` field rather than a scan of everyone's preferences.
 */

const SEND_TTL_SECONDS = 60 * 60 * 24 * 60;

let indexesReady: Promise<unknown> | null = null;

export function reminderCollections() {
  const db = getAuthDb();
  const subscriptions = db.collection(AUTH_COLLECTIONS.reminderSubscriptions);
  const sends = db.collection(AUTH_COLLECTIONS.reminderSends);
  indexesReady ??= Promise.all([
    subscriptions.createIndex({ userId: 1 }, { unique: true }),
    subscriptions.createIndex({ enabled: 1 }),
    sends.createIndex({ userId: 1, sessionId: 1, leadMinutes: 1 }, { unique: true }),
    sends.createIndex({ claimedAt: 1 }, { expireAfterSeconds: SEND_TTL_SECONDS }),
  ]).catch((error) => {
    indexesReady = null;
    throw error;
  });
  return { subscriptions, sends, ready: indexesReady };
}

export async function readReminderSettings(userId: string): Promise<ReminderSettings> {
  const { subscriptions } = reminderCollections();
  return pickReminderSettings(await subscriptions.findOne({ userId }));
}

export async function writeReminderSettings(
  user: { id: string; email: string },
  settings: ReminderSettings
): Promise<ReminderSettings> {
  const { subscriptions, ready } = reminderCollections();
  await ready;
  const $set: Record<string, unknown> = {
    enabled: settings.enabled,
    sessionTypes: settings.sessionTypes,
    leadMinutes: settings.leadMinutes,
    email: user.email,
    updatedAt: new Date(),
  };
  if (settings.timeZone) $set.timeZone = settings.timeZone;
  const doc = await subscriptions.findOneAndUpdate(
    { userId: user.id },
    {
      $set,
      ...(settings.timeZone ? {} : { $unset: { timeZone: "" } }),
      $setOnInsert: { userId: user.id, createdAt: new Date() },
    },
    { upsert: true, returnDocument: "after" }
  );
  return pickReminderSettings(doc);
}

/** Turn reminders off. True when a subscription existed. */
export async function disableReminders(userId: string): Promise<boolean> {
  const { subscriptions } = reminderCollections();
  const result = await subscriptions.updateOne(
    { userId },
    { $set: { enabled: false, updatedAt: new Date(), unsubscribedAt: new Date() } }
  );
  return result.matchedCount > 0;
}

function keyFilter(key: SendKey) {
  return { userId: key.userId, sessionId: key.sessionId, leadMinutes: key.leadMinutes };
}

export function mongoReminderStore(): ReminderStore {
  const { subscriptions, sends, ready } = reminderCollections();
  return {
    async listEnabledSubscriptions() {
      await ready;
      const docs = await subscriptions.find({ enabled: true }).limit(10_000).toArray();
      const out: ReminderSubscription[] = [];
      for (const doc of docs) {
        if (typeof doc.userId !== "string" || typeof doc.email !== "string") continue;
        out.push({ ...pickReminderSettings(doc), userId: doc.userId, email: doc.email });
      }
      return out;
    },
    async countSendsSince(since) {
      return sends.countDocuments({ claimedAt: { $gte: since } });
    },
    async wasClaimed(key) {
      return (await sends.countDocuments(keyFilter(key), { limit: 1 })) > 0;
    },
    async claimSend(key, at) {
      await ready;
      try {
        await sends.insertOne({ ...keyFilter(key), claimedAt: at, status: "claimed" });
        return true;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) return false;
        throw error;
      }
    },
    async markSend(key, outcome) {
      await sends.updateOne(keyFilter(key), {
        $set: {
          status: outcome.status,
          ...(outcome.error ? { error: outcome.error } : {}),
          finishedAt: new Date(),
        },
      });
    },
  };
}

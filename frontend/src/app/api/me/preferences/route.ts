import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { AUTH_COLLECTIONS, getAuthDb } from "@/lib/auth-db";
import {
  MAX_PATCH_BODY_BYTES,
  PREFERENCE_KEYS,
  pickPreferences,
  validatePreferencesPatch,
} from "@/lib/preferences";

/**
 * `GET /api/me/preferences` — the signed-in user's stored preferences.
 * `PUT /api/me/preferences` — write one or more namespaces.
 *
 * One document per user in `user_preferences`, keyed by the user id STRING
 * (`userId`), with a unique index so two racing first writes cannot create
 * two documents.
 *
 * PUT takes a partial body: each namespace present replaces that namespace
 * wholesale, `null` deletes it, absent namespaces are untouched. That is
 * what lets the favourites picker, the home layout and the spoiler settings
 * each write their own key without reading — and racing — the others. The
 * full rules live in `lib/preferences.ts`; this handler only applies them.
 *
 * Both methods answer with the complete stored document, so the client's
 * optimistic state is always reconciled against what the server holds.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

let indexReady: Promise<unknown> | null = null;

function collection() {
  const prefs = getAuthDb().collection(AUTH_COLLECTIONS.preferences);
  indexReady ??= prefs.createIndex({ userId: 1 }, { unique: true }).catch(() => {
    indexReady = null;
  });
  return { prefs, ready: indexReady };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "signed_out" }, { status: 401, headers: NO_STORE });
  }
  const { prefs } = collection();
  const doc = await prefs.findOne({ userId: user.id });
  return NextResponse.json({ preferences: pickPreferences(doc) }, { headers: NO_STORE });
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "signed_out" }, { status: 401, headers: NO_STORE });
  }

  // Read as text first so the size check happens before any parsing.
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_PATCH_BODY_BYTES) {
    return NextResponse.json(
      { error: "too_large", message: `Body exceeds ${MAX_PATCH_BODY_BYTES} bytes` },
      { status: 413, headers: NO_STORE }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { error: "invalid", message: "Body must be JSON" },
      { status: 400, headers: NO_STORE }
    );
  }

  const result = validatePreferencesPatch(body);
  if (!result.ok) {
    return NextResponse.json(
      { error: "invalid", message: result.error },
      { status: 400, headers: NO_STORE }
    );
  }

  const $set: Record<string, unknown> = { updatedAt: new Date() };
  const $unset: Record<string, ""> = {};
  for (const key of PREFERENCE_KEYS) {
    if (!(key in result.patch)) continue;
    const value = result.patch[key];
    if (value === null || value === undefined) $unset[key] = "";
    else $set[key] = value;
  }

  const { prefs, ready } = collection();
  await ready;
  const doc = await prefs.findOneAndUpdate(
    { userId: user.id },
    {
      $set,
      ...(Object.keys($unset).length > 0 ? { $unset } : {}),
      $setOnInsert: { userId: user.id, createdAt: new Date() },
    },
    { upsert: true, returnDocument: "after" }
  );

  return NextResponse.json({ preferences: pickPreferences(doc) }, { headers: NO_STORE });
}

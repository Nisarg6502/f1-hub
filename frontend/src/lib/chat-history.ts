/**
 * Saved chat history — the client for `f1-agent`'s `/api/conversations*`.
 *
 * Account-only by design: every call here needs the bearer token from
 * `agent-auth.ts`, and a guest never reaches this module (the panel shows a
 * "Sign in to keep your chats" line instead). The backend side, including what
 * is stored and why, is `backend/agent/conversations.py`; the shapes below
 * mirror its `summary()` / `public()` output and its message documents.
 *
 * Kept out of `agent-api.ts` on purpose: that module is the SSE chat contract,
 * and this is ordinary JSON CRUD with a different failure posture — a history
 * request that fails is shown as a failure ("couldn't load your chats"), never
 * dressed up as an agent error inside a message bubble.
 */

import {
  AGENT_BASE_URL,
  type AgentAnchor,
  type AgentSource,
  type AgentVisual,
} from "./agent-api";
import { getAgentToken } from "./agent-auth";

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string | null;
  updated_at: string | null;
  message_count: number;
}

/**
 * One stored message. `content` is the answer's raw draft with its `[ev_N]`
 * markers intact — `citations.anchors` index into exactly that text, so the
 * panel feeds it through the same `buildAnchoredMarkdown` a live answer uses.
 */
export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  created_at: string | null;
  visuals?: AgentVisual[];
  citations?: { sources?: AgentSource[]; anchors?: AgentAnchor[] };
  followups?: string[];
  run_id?: string | null;
  meta?: {
    tier?: number | null;
    verification?: "passed" | "verification_failed" | null;
    mode?: "model" | "echo";
    elapsed_ms?: number;
    cached?: boolean;
  };
  /** How many charts were dropped to fit the per-message storage cap. */
  visuals_omitted?: number;
}

export interface Conversation extends ConversationSummary {
  messages: StoredMessage[];
}

export interface ConversationPage {
  items: ConversationSummary[];
  next_cursor: string | null;
}

export type HistoryErrorCode =
  | "signed_out"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "network";

export class HistoryError extends Error {
  constructor(
    public code: HistoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HistoryError";
  }
}

/**
 * One authenticated request, with a single silent retry on 401.
 *
 * The cached token can go bad without this tab knowing — the user signed out
 * elsewhere, the secret rotated, or the laptop slept through the refresh
 * window. A 401 therefore forces one fresh token and one retry before the
 * caller hears about it; a second 401 really does mean signed out.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getAgentToken(attempt === 0 ? undefined : { forceRefresh: true });
    if (!token) throw new HistoryError("signed_out", "Sign in to keep your chats.");
    let res: Response;
    try {
      res = await fetch(new URL(path, AGENT_BASE_URL).toString(), {
        ...init,
        cache: "no-store",
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      throw new HistoryError("network", "Couldn't reach your saved chats. Check your connection.");
    }
    if (res.status === 401 && attempt === 0) continue;
    if (res.ok) return res;
    if (res.status === 401) throw new HistoryError("signed_out", "Sign in to keep your chats.");
    if (res.status === 404) throw new HistoryError("not_found", "That chat no longer exists.");
    if (res.status === 429) {
      throw new HistoryError("rate_limited", "Too many requests — give it a moment and try again.");
    }
    throw new HistoryError("unavailable", "Saved chats can't be reached right now. Try again shortly.");
  }
  // Unreachable: the loop either returns or throws on its second pass.
  throw new HistoryError("signed_out", "Sign in to keep your chats.");
}

export async function listConversations(
  options: { cursor?: string | null; query?: string; limit?: number; signal?: AbortSignal } = {}
): Promise<ConversationPage> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 30));
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.query?.trim()) params.set("q", options.query.trim());
  const res = await authedFetch(`/api/conversations?${params}`, { signal: options.signal });
  return (await res.json()) as ConversationPage;
}

export async function getConversation(id: string, signal?: AbortSignal): Promise<Conversation> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}`, { signal });
  return (await res.json()) as Conversation;
}

export async function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  const res = await authedFetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
  return (await res.json()) as ConversationSummary;
}

export async function deleteConversation(id: string): Promise<void> {
  await authedFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function deleteAllConversations(): Promise<number> {
  const res = await authedFetch(`/api/conversations`, { method: "DELETE" });
  const body = (await res.json()) as { deleted?: number };
  return body.deleted ?? 0;
}

export type HistoryGroupLabel = "Today" | "Yesterday" | "Previous 7 days" | "Older";

export interface HistoryGroup {
  label: HistoryGroupLabel;
  items: ConversationSummary[];
}

const GROUP_ORDER: HistoryGroupLabel[] = ["Today", "Yesterday", "Previous 7 days", "Older"];

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Bucket conversations by their last activity, in the reader's own calendar.
 *
 * Calendar days, not rolling 24-hour windows: a chat from 11pm last night is
 * "Yesterday" at 9am today even though it is only ten hours old, because that
 * is what the word means to the person reading it. "Previous 7 days" is the
 * six days before yesterday, so the four buckets never overlap. Day starts
 * are computed with local `setHours(0,0,0,0)` rather than by subtracting
 * 86,400,000ms, which would put a daylight-saving changeover an hour off.
 *
 * Input order is preserved within each bucket (the API already returns newest
 * first) and empty buckets are dropped, so the list never shows a heading with
 * nothing under it. A row with no parseable timestamp goes to "Older" rather
 * than disappearing.
 */
export function groupConversations(
  items: ConversationSummary[],
  nowMs: number = Date.now()
): HistoryGroup[] {
  const today = startOfLocalDay(nowMs);
  const yesterdayDate = new Date(today);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = yesterdayDate.getTime();
  const weekDate = new Date(today);
  weekDate.setDate(weekDate.getDate() - 7);
  const weekAgo = weekDate.getTime();

  const buckets = new Map<HistoryGroupLabel, ConversationSummary[]>(
    GROUP_ORDER.map((label) => [label, []])
  );
  for (const item of items) {
    const at = item.updated_at ? Date.parse(item.updated_at) : NaN;
    const label: HistoryGroupLabel = !Number.isFinite(at)
      ? "Older"
      : at >= today
        ? "Today"
        : at >= yesterday
          ? "Yesterday"
          : at >= weekAgo
            ? "Previous 7 days"
            : "Older";
    buckets.get(label)!.push(item);
  }
  return GROUP_ORDER.map((label) => ({ label, items: buckets.get(label)! })).filter(
    (group) => group.items.length > 0
  );
}

/**
 * The short time shown on a history row: a clock time for today, a weekday
 * within the week, a date beyond it. Same buckets as {@link groupConversations},
 * so a row never says "Mon" under a "Today" heading.
 */
export function formatHistoryTime(iso: string | null, nowMs: number = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const today = startOfLocalDay(nowMs);
  if (at >= today) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  const weekDate = new Date(today);
  weekDate.setDate(weekDate.getDate() - 7);
  if (at >= weekDate.getTime()) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

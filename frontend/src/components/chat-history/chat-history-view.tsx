"use client";

/**
 * The saved-chats list inside the Pitwall Assistant panel — signed-in only.
 *
 * Rendered by `pitwall-assistant-panel.tsx` *in place of* the message list and
 * composer while the History control is active, rather than as a second
 * drawer or a popover. The panel is already a 480px modal with its own focus
 * trap; a nested overlay would need a second trap and a second Escape
 * contract, and on a phone there is no room beside the transcript for a list
 * anyway. Swapping the body keeps one dialog, one header, one way out.
 *
 * Everything that talks to the agent goes through `lib/chat-history.ts`, which
 * owns token refresh (one silent retry on 401). This component owns only the
 * list's state: loading, empty, error, search, paging, and the two inline
 * confirmations.
 *
 * Confirmations are inline rows, not `window.confirm`, for the reason the
 * panel's own New chat confirmation gives: a native dialog is the one unstyled
 * surface in the app and it steals focus out of the dialog's trap. Escape
 * inside a rename field or a confirmation cancels *that* and is stopped there,
 * because the panel listens for Escape on `window` to close itself — one key
 * press must not both cancel an edit and throw away the panel.
 *
 * Hit areas: every icon button is 28px visually with a `before:-inset-1.5`
 * pseudo-element, giving a 40px target without crowding the row (the pattern
 * the panel's Copy and Ask-again buttons already use). On touch screens the
 * row actions are always visible; with a mouse they appear on hover or focus,
 * so a long list reads as titles, not as a column of trash cans.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Check, MessageSquarePlus, Pencil, Search, Trash2, X } from "lucide-react";
import {
  deleteAllConversations,
  deleteConversation,
  formatHistoryTime,
  getConversation,
  groupConversations,
  HistoryError,
  listConversations,
  renameConversation,
  type Conversation,
  type ConversationSummary,
} from "@/lib/chat-history";

const ICON_BUTTON =
  "relative before:absolute before:-inset-1.5 before:content-[''] flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-on-surface-variant)] transition-[background-color,color,transform,opacity] duration-150 hover:bg-white/5 hover:text-[var(--color-on-surface)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)] active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40";

const TEXT_BUTTON =
  "relative before:absolute before:-inset-y-2 before:content-[''] rounded-lg px-2.5 py-1 text-[11px] font-medium transition-[color,background-color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)] disabled:pointer-events-none disabled:opacity-40";

const SEARCH_DEBOUNCE_MS = 250;

type Status = "loading" | "ready" | "error";

export default function ChatHistoryView({
  activeThreadId,
  onOpen,
  onBack,
  onNewChat,
  onDeleted,
  onDeletedAll,
  onSignedOut,
}: {
  /** The conversation currently in the panel, highlighted in the list. */
  activeThreadId: string | null;
  /** A conversation was fetched in full and should replace the transcript. */
  onOpen: (conversation: Conversation) => void;
  onBack: () => void;
  onNewChat: () => void;
  /** A chat was deleted — the panel resets if it was the open one. */
  onDeleted: (id: string) => void;
  onDeletedAll: () => void;
  /** The token turned out to be gone; the panel falls back to guest mode. */
  onSignedOut: () => void;
}) {
  const reduce = useReducedMotion();
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof HistoryError && err.code === "signed_out") onSignedOut();
      return err instanceof HistoryError ? err.message : "Something went wrong loading your chats.";
    },
    [onSignedOut]
  );

  // First page, refetched whenever the search settles or Retry is pressed.
  // The abort makes a fast typist's stale page unable to land after a newer
  // one — the later request is the only one whose answer is kept.
  useEffect(() => {
    const controller = new AbortController();
    listConversations({ query: debouncedQuery, signal: controller.signal })
      .then((page) => {
        setItems(page.items);
        setCursor(page.next_cursor);
        setStatus("ready");
        setError(null);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setError(fail(err));
        setStatus("error");
      });
    return () => controller.abort();
  }, [debouncedQuery, reloadKey, fail]);

  const retry = useCallback(() => {
    setStatus("loading");
    setReloadKey((k) => k + 1);
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listConversations({ query: debouncedQuery, cursor });
      // De-duplicated by id: a chat continued in another tab between pages
      // moves to the top and could otherwise appear twice.
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
      });
      setCursor(page.next_cursor);
    } catch (err) {
      setError(fail(err));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, debouncedQuery, fail]);

  const open = useCallback(
    async (id: string) => {
      if (openingId) return;
      setOpeningId(id);
      setRowError(null);
      try {
        onOpen(await getConversation(id));
      } catch (err) {
        if (err instanceof HistoryError && err.code === "not_found") {
          setItems((prev) => prev.filter((i) => i.id !== id));
        }
        setRowError({ id, message: fail(err) });
      } finally {
        setOpeningId(null);
      }
    },
    [openingId, onOpen, fail]
  );

  const saveRename = useCallback(async () => {
    if (!renaming) return;
    const title = renaming.draft.trim();
    const original = items.find((i) => i.id === renaming.id);
    if (!title || title === original?.title) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    try {
      const row = await renameConversation(renaming.id, title);
      setItems((prev) => prev.map((i) => (i.id === row.id ? { ...i, title: row.title } : i)));
      setRenaming(null);
    } catch (err) {
      setRowError({ id: renaming.id, message: fail(err) });
    } finally {
      setBusy(false);
    }
  }, [renaming, items, fail]);

  const confirmDelete = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await deleteConversation(id);
      } catch (err) {
        // Already gone is the outcome the reader asked for.
        if (!(err instanceof HistoryError && err.code === "not_found")) {
          setRowError({ id, message: fail(err) });
          setBusy(false);
          return;
        }
      }
      setItems((prev) => prev.filter((i) => i.id !== id));
      setConfirmingDelete(null);
      setBusy(false);
      onDeleted(id);
    },
    [fail, onDeleted]
  );

  const confirmDeleteAll = useCallback(async () => {
    setBusy(true);
    try {
      await deleteAllConversations();
      setItems([]);
      setCursor(null);
      setConfirmingDeleteAll(false);
      onDeletedAll();
    } catch (err) {
      setError(fail(err));
    } finally {
      setBusy(false);
    }
  }, [fail, onDeletedAll]);

  // Bucketed against a clock read once per list change, not per render — the
  // headings must not reshuffle under the reader while they are looking.
  const groups = useMemo(() => {
    const now = Date.now();
    return groupConversations(items).map((group) => ({
      ...group,
      items: group.items.map((item) => ({ item, time: formatHistoryTime(item.updated_at, now) })),
    }));
  }, [items]);

  const stopEscape = (event: React.KeyboardEvent, cancel: () => void) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  const rowTransition = reduce ? { duration: 0.12 } : { duration: 0.18, ease: [0.23, 1, 0.32, 1] as const };

  return (
    <div role="region" aria-label="Saved chats" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back to chat" title="Back to chat" className={ICON_BUTTON}>
          <ArrowLeft size={15} aria-hidden />
        </button>
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-[var(--color-surface-container-low)] px-2.5 py-1.5 focus-within:border-[var(--color-primary)]/50">
          <Search size={13} className="shrink-0 text-[var(--color-on-surface-variant)]" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) stopEscape(e, () => setQuery(""));
            }}
            aria-label="Search saved chats"
            placeholder="Search your chats"
            maxLength={100}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-on-surface)] outline-none placeholder:text-[var(--color-on-surface-variant)]"
          />
        </label>
        <button
          type="button"
          onClick={onNewChat}
          className={`${TEXT_BUTTON} flex items-center gap-1.5 bg-[var(--color-primary)] py-1.5 font-semibold text-[var(--color-on-primary)]`}
        >
          <MessageSquarePlus size={13} aria-hidden />
          New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {status === "loading" && (
          <ul aria-label="Loading saved chats" className="space-y-2 px-1" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <li
                key={i}
                className="h-11 rounded-lg bg-white/[0.04] motion-safe:animate-pulse"
                style={{ opacity: 1 - i * 0.18 }}
              />
            ))}
          </ul>
        )}

        {status === "error" && (
          <div className="flex flex-col items-start gap-2 px-1 py-2">
            <p className="text-sm text-[var(--color-error)]">{error}</p>
            <button
              type="button"
              onClick={retry}
              className={`${TEXT_BUTTON} border border-white/10 bg-surface-container-low/50 text-warm-200 hover:bg-surface-container-low/70`}
            >
              Try again
            </button>
          </div>
        )}

        {status === "ready" && items.length === 0 && (
          <div className="px-1 py-6 text-center">
            <p className="text-sm text-[var(--color-on-surface)]">
              {debouncedQuery ? "No chats match that search." : "No saved chats yet."}
            </p>
            <p className="mt-1 text-[11px] text-[var(--color-on-surface-variant)]">
              {debouncedQuery
                ? "Search looks at chat titles only."
                : "Ask the assistant something and the conversation will be kept here."}
            </p>
          </div>
        )}

        {status === "ready" &&
          groups.map((group) => (
            <section key={group.label} aria-label={group.label} className="mb-3 last:mb-0">
              <h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)]">
                {group.label}
              </h3>
              <ul className="space-y-0.5">
                <AnimatePresence initial={false}>
                  {group.items.map(({ item, time }) => {
                    const active = item.id === activeThreadId;
                    const isRenaming = renaming?.id === item.id;
                    const isConfirming = confirmingDelete === item.id;
                    return (
                      <motion.li
                        key={item.id}
                        layout={reduce ? false : "position"}
                        initial={false}
                        exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                        transition={rowTransition}
                        className="overflow-hidden"
                      >
                        {isConfirming ? (
                          <div className="flex items-center gap-2 rounded-lg bg-[var(--color-error-container)]/20 px-2.5 py-2">
                            <p className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-on-surface)]">
                              Delete &ldquo;{item.title}&rdquo;?
                            </p>
                            <button
                              type="button"
                              autoFocus
                              onKeyDown={(e) => stopEscape(e, () => setConfirmingDelete(null))}
                              onClick={() => setConfirmingDelete(null)}
                              className={`${TEXT_BUTTON} text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]`}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onKeyDown={(e) => stopEscape(e, () => setConfirmingDelete(null))}
                              onClick={() => confirmDelete(item.id)}
                              className={`${TEXT_BUTTON} bg-[var(--color-error)] font-semibold text-[var(--color-on-error)]`}
                            >
                              Delete
                            </button>
                          </div>
                        ) : isRenaming ? (
                          <form
                            className="flex items-center gap-1 rounded-lg bg-white/[0.05] px-2 py-1.5"
                            onSubmit={(e) => {
                              e.preventDefault();
                              saveRename();
                            }}
                          >
                            <input
                              autoFocus
                              value={renaming.draft}
                              maxLength={80}
                              aria-label="Chat title"
                              onChange={(e) => setRenaming({ id: item.id, draft: e.target.value })}
                              onKeyDown={(e) => stopEscape(e, () => setRenaming(null))}
                              onFocus={(e) => e.currentTarget.select()}
                              className="min-w-0 flex-1 bg-transparent px-1 text-[13px] text-[var(--color-on-surface)] outline-none"
                            />
                            <button type="submit" disabled={busy} aria-label="Save title" className={ICON_BUTTON}>
                              <Check size={14} aria-hidden />
                            </button>
                            <button
                              type="button"
                              aria-label="Cancel rename"
                              onClick={() => setRenaming(null)}
                              className={ICON_BUTTON}
                            >
                              <X size={14} aria-hidden />
                            </button>
                          </form>
                        ) : (
                          <div
                            className={`group flex items-center gap-1 rounded-lg pr-1 transition-colors duration-150 ${
                              active ? "bg-[var(--color-primary)]/10" : "hover:bg-white/[0.04]"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => open(item.id)}
                              aria-current={active ? "true" : undefined}
                              disabled={openingId !== null}
                              className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)] disabled:cursor-wait"
                            >
                              <span
                                className={`min-w-0 flex-1 truncate text-[13px] ${
                                  active ? "text-[var(--color-primary)]" : "text-[var(--color-on-surface)]"
                                }`}
                              >
                                {item.title}
                              </span>
                              <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-on-surface-variant)]">
                                {openingId === item.id ? "Opening…" : time}
                              </span>
                            </button>
                            <div className="flex items-center gap-0.5 opacity-100 transition-opacity duration-150 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
                              <button
                                type="button"
                                aria-label={`Rename “${item.title}”`}
                                title="Rename"
                                onClick={() => {
                                  setConfirmingDelete(null);
                                  setRenaming({ id: item.id, draft: item.title });
                                }}
                                className={ICON_BUTTON}
                              >
                                <Pencil size={13} aria-hidden />
                              </button>
                              <button
                                type="button"
                                aria-label={`Delete “${item.title}”`}
                                title="Delete"
                                onClick={() => {
                                  setRenaming(null);
                                  setConfirmingDelete(item.id);
                                }}
                                className={ICON_BUTTON}
                              >
                                <Trash2 size={13} aria-hidden />
                              </button>
                            </div>
                          </div>
                        )}
                        {rowError?.id === item.id && (
                          <p role="alert" className="px-2.5 pb-1 text-[11px] text-[var(--color-error)]">
                            {rowError.message}
                          </p>
                        )}
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ul>
            </section>
          ))}

        {status === "ready" && cursor && (
          <div className="flex justify-center pt-1">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className={`${TEXT_BUTTON} text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]`}
            >
              {loadingMore ? "Loading…" : "Show older chats"}
            </button>
          </div>
        )}
        {status === "ready" && error && items.length > 0 && (
          <p role="alert" className="px-2 pt-2 text-[11px] text-[var(--color-error)]">
            {error}
          </p>
        )}
      </div>

      {status === "ready" && items.length > 0 && !debouncedQuery && (
        <div className="border-t border-white/10 px-3 py-2">
          {confirmingDeleteAll ? (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-[11px] text-[var(--color-on-surface)]">
                Delete every saved chat? This can&rsquo;t be undone.
              </p>
              <button
                type="button"
                autoFocus
                onKeyDown={(e) => stopEscape(e, () => setConfirmingDeleteAll(false))}
                onClick={() => setConfirmingDeleteAll(false)}
                className={`${TEXT_BUTTON} text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]`}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onKeyDown={(e) => stopEscape(e, () => setConfirmingDeleteAll(false))}
                onClick={confirmDeleteAll}
                className={`${TEXT_BUTTON} bg-[var(--color-error)] font-semibold text-[var(--color-on-error)]`}
              >
                Delete all
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDeleteAll(true)}
              className={`${TEXT_BUTTON} text-[var(--color-on-surface-variant)] hover:text-[var(--color-error)]`}
            >
              Delete all chats
            </button>
          )}
        </div>
      )}
    </div>
  );
}

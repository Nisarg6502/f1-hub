"use client";

/**
 * The production Pitwall Assistant panel — CP66.
 *
 * A portaled right-side drawer, reachable from anywhere in the app via the
 * nav trigger (`pitwall-assistant-launcher.tsx`), replacing `/pitwall-chat`
 * (CP61's unlinked dev preview, kept around for isolated debugging but no
 * longer the intended way to use the assistant). Follows this app's
 * established portal pattern (`driver-modal.tsx`, `circuit-details-modal.tsx`,
 * `circuit-compare-modal.tsx`): `<main>` in `layout.tsx` has `relative z-10`,
 * which creates a stacking context, so any descendant's z-index compares
 * against the nav's `z-50` rather than the page root — every overlay in this
 * app portals to `document.body` for exactly this reason, and this one is no
 * exception.
 *
 * Two things this panel does that the CP61 dev page did not:
 * - **A full activity timeline**, not just the in-progress entries. The dev
 *   page filtered to only currently-active steps; this renders every step in
 *   order, which is what makes CP63's subagent delegation and CP64's
 *   verification pass actually visible rather than flickering past.
 * - **Renders the `tier`/`verification` fields** `done` now carries, as a
 *   small, unobtrusive badge — not because a user needs to know what a "tier"
 *   is, but because a `verification_failed` badge is a plain, honest signal
 *   that this specific answer could not be fully checked, which is more
 *   useful than hiding it and identical in spirit to the `mode === "echo"`
 *   warning the dev page already showed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { motion, useReducedMotion } from "motion/react";
import {
  streamChat,
  postFeedback,
  rewriteCitations,
  ERROR_COPY,
  type AgentDone,
  type AgentSource,
} from "@/lib/agent-api";
import CitationPill from "./citation-pill";
import SourceCard from "./source-card";
import LocalDateTime from "./local-datetime";
import FeedbackControls from "./feedback-controls";

type ActivityEntry = {
  label: string;
  state: "start" | "done";
  detail?: string | null;
  kind: "tool" | "agent" | "system";
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  activity: ActivityEntry[];
  sources: AgentSource[];
  done: AgentDone | null;
  error: { code: string; message: string } | null;
  // Client-side send/creation time (CP68) — this doesn't need to come from
  // the backend, it just needs to be stable for the life of the bubble, the
  // same reasoning `source-card.tsx` already applies to `as_of` via
  // `LocalDateTime`.
  timestampMs: number;
  // CP69: one vote per message, client-side only. `done.run_id` (already
  // present since CP63/CP69's own research) is the id `postFeedback` needs —
  // no separate field required, `FeedbackControls` reads it straight off
  // `message.done`.
  feedback: 1 | -1 | null;
  // CP70: the paired user question text, captured at creation time on the
  // assistant message so Retry/Regenerate can re-submit it without threading
  // a second data structure through. `null` on user messages (meaningless
  // there) and left unused for them.
  question: string | null;
};

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `m${nextId}`;
}

/**
 * Contextual suggested prompts (CP70). Matched on route *shape* — via regex
 * against the pathname's segment pattern — rather than exact strings, since
 * `/schedule/[season]/[round]` and `/circuits/[circuitId]` are dynamically
 * routed and the actual season/round/circuit values are unbounded. Checked
 * most-specific-first (the pitwall live-session route is a more specific
 * case of the season/round race-weekend route, so it must be tested before
 * the broader pattern or it would never match).
 */
const ROUTE_SUGGESTIONS: { pattern: RegExp; suggestions: string[] }[] = [
  {
    // /schedule/[season]/[round]/pitwall — the live/session timing page.
    pattern: /^\/schedule\/[^/]+\/[^/]+\/pitwall\/?$/,
    suggestions: [
      "What's happening in this session right now?",
      "Summarize the race control messages so far",
      "Who's currently on the fastest lap?",
    ],
  },
  {
    // /schedule/[season]/[round] — a single race weekend's results/details.
    pattern: /^\/schedule\/[^/]+\/[^/]+\/?$/,
    suggestions: [
      "Who won this race?",
      "Walk me through this race's key moments",
      "What was the podium and fastest lap?",
    ],
  },
  {
    // /schedule — the full-season calendar/list.
    pattern: /^\/schedule\/?$/,
    suggestions: [
      "When is the next race?",
      "How many races are left this season?",
      "Which circuit hosts the most iconic race?",
    ],
  },
  {
    pattern: /^\/standings\/?$/,
    suggestions: [
      "Who's leading the drivers' championship?",
      "How close is the constructors' title fight?",
      "How has the championship lead changed this season?",
    ],
  },
  {
    pattern: /^\/drivers\/?$/,
    suggestions: [
      "Compare Verstappen and Norris this season",
      "Who has the most race wins this season?",
      "Which driver has the best qualifying record?",
    ],
  },
  {
    pattern: /^\/teams\/?$/,
    suggestions: [
      "Which team has the fastest car this season?",
      "Compare the top two constructors this season",
      "Who has the most reliable car this season?",
    ],
  },
  {
    // /circuits/[circuitId] — a single circuit's detail page.
    pattern: /^\/circuits\/[^/]+\/?$/,
    suggestions: [
      "What's the lap record at this circuit?",
      "Who has won the most races here?",
      "What makes this circuit challenging to drive?",
    ],
  },
  {
    // /circuits — the full circuit gallery/list.
    pattern: /^\/circuits\/?$/,
    suggestions: [
      "Who has the most wins at Monaco in F1 history?",
      "Which circuit has produced the most overtakes?",
      "What's the fastest circuit on the calendar?",
    ],
  },
  {
    pattern: /^\/telemetry\/?$/,
    suggestions: [
      "What's happening in the session right now?",
      "Who's currently fastest on track?",
      "Explain what these telemetry traces show",
    ],
  },
  {
    pattern: /^\/history\/?$/,
    suggestions: [
      "Who has the most world championships?",
      "What was the closest title fight in F1 history?",
      "Tell me about a famous rivalry in F1 history",
    ],
  },
];

const DEFAULT_SUGGESTIONS = [
  "Who won the last race?",
  "Compare Verstappen and Norris this season",
  "Who has the most wins at Monaco in F1 history?",
];

/**
 * Pure lookup: pathname → the 3 suggestions shown before the first message.
 * Falls back to `DEFAULT_SUGGESTIONS` for the home page and any route this
 * table doesn't otherwise recognize, so a new page added later degrades
 * gracefully instead of rendering nothing.
 */
function suggestionsForPath(pathname: string): string[] {
  const match = ROUTE_SUGGESTIONS.find((entry) => entry.pattern.test(pathname));
  return match ? match.suggestions : DEFAULT_SUGGESTIONS;
}

export default function PitwallAssistantPanel({
  onClose,
}: {
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  // CP70: suggested prompts vary by the page the panel was opened from —
  // `usePathname()` is the same established pattern `nav-links.tsx` already
  // uses for its own active-link highlighting. `suggestionsForPath` is
  // called directly at its JSX usage site below rather than hoisted into a
  // top-level `const` here: hoisting it confused the React Compiler's
  // dependency inference for the unrelated `ask` callback further down
  // (`Compilation Skipped: Existing memoization could not be preserved`) —
  // calling it inline at the render site sidesteps that without changing
  // behavior, since it's a cheap pure function either way.
  const pathname = usePathname();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  // Persisted for the life of this mount only — the backend checkpointer
  // gives real Mongo-backed thread memory server-side; the client only needs
  // to keep sending the same id so consecutive turns land in the same
  // thread. Regenerated each time the panel opens fresh (a new mount), so
  // closing and reopening starts a new conversation rather than an
  // indefinitely-growing one.
  const threadId = useRef(crypto.randomUUID());
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Auto-scroll-while-streaming (CP70). A ref, not state — this is read on
  // every scroll tick and every token, and re-rendering the whole panel on
  // each scroll pixel would be wasteful. `true` until the user scrolls away
  // from the bottom themselves; sending a new question always resets it,
  // since submitting implies "show me the answer".
  const messageListRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  // Elapsed-time indicator (CP70). Purely client-side and independent of the
  // backend SSE heartbeat — `Date.now()` at submit time, ticked every second
  // via `setInterval` while a turn is in flight. Once `done` arrives we stop
  // trusting the client clock and switch to `AgentDone.elapsed_ms`, the
  // server's own settled figure, which is why this is `number | null` rather
  // than derived purely from a start-time ref: `null` means "no turn
  // in flight and nothing to show".
  const [elapsedSec, setElapsedSec] = useState<number | null>(null);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopElapsedTimer = useCallback(() => {
    if (elapsedIntervalRef.current !== null) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
  }, []);

  const handleMessageListScroll = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return;
    const THRESHOLD = 48;
    isAtBottomRef.current =
      el.scrollTop + el.clientHeight >= el.scrollHeight - THRESHOLD;
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = "auto";
      window.removeEventListener("keydown", handleKeyDown);
      // A closed panel must not keep burning quota for a question nobody
      // is watching anymore — the same reasoning `agent-api.ts`'s own
      // docstring gives for supporting `signal` at all.
      abortRef.current?.abort();
      stopElapsedTimer();
    };
  }, [onClose, stopElapsedTimer]);

  // Shared by `ask`'s stream handlers and `FeedbackControls`' `onVote` — one
  // state-update mechanism for "patch the message with this id", not two.
  const patchMessage = useCallback(
    (id: string, fn: (m: Message) => Message) =>
      setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m))),
    []
  );

  const onVote = useCallback(
    (messageId: string, runId: string, score: 1 | -1, comment?: string) => {
      postFeedback(runId, score, comment);
      patchMessage(messageId, (m) => ({ ...m, feedback: score }));
    },
    [patchMessage]
  );

  const ask = useCallback(
    (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || running) return;
      setInput("");
      // A fresh question always implies "show me the answer" — resume
      // auto-follow even if the user had scrolled up during a prior turn.
      isAtBottomRef.current = true;

      const userMessage: Message = {
        id: newId(),
        role: "user",
        text: trimmed,
        activity: [],
        sources: [],
        done: null,
        error: null,
        timestampMs: Date.now(),
        feedback: null,
        question: null,
      };
      const assistantId = newId();
      const assistantMessage: Message = {
        id: assistantId,
        role: "assistant",
        text: "",
        activity: [],
        sources: [],
        done: null,
        error: null,
        timestampMs: Date.now(),
        feedback: null,
        question: trimmed,
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setRunning(true);

      // Start the elapsed-time tick. `startedAt` is closed over rather than
      // read from a ref on every tick — it's fixed for the life of this
      // turn, same reasoning `ask` already applies to `trimmed`.
      const startedAt = Date.now();
      setElapsedSec(0);
      stopElapsedTimer();
      elapsedIntervalRef.current = setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
      }, 1000);

      const controller = new AbortController();
      abortRef.current = controller;

      const patch = (fn: (m: Message) => Message) => patchMessage(assistantId, fn);

      streamChat(
        trimmed,
        {
          onActivity: (label, state, detail, kind) =>
            patch((m) => ({
              ...m,
              activity: [...m.activity, { label, state, detail, kind: kind ?? "system" }],
            })),
          onToken: (text) => patch((m) => ({ ...m, text: m.text + text })),
          onSources: (sources) => patch((m) => ({ ...m, sources })),
          onDone: (done) => patch((m) => ({ ...m, done })),
          onError: (code, message) =>
            patch((m) => ({ ...m, error: { code, message } })),
        },
        { threadId: threadId.current, signal: controller.signal }
      )
        .catch((err: Error) => {
          if (err.name === "AbortError") return;
          // Pre-connection failures (e.g. the browser's raw "Failed to
          // fetch") never get a code from the backend, so they're coded
          // "network" here rather than surfacing `err.message` verbatim —
          // see the plan's own note on why this literal path was the live
          // bug this checkpoint closes. `MessageBubble` looks up human copy
          // for "network" the same way it does for any coded SSE error.
          patch((m) => ({
            ...m,
            error: { code: "network", message: err.message },
          }));
        })
        .finally(() => {
          stopElapsedTimer();
          setRunning(false);
        });
    },
    [running, patchMessage, stopElapsedTimer]
  );

  const send = useCallback(() => ask(input), [ask, input]);
  const cancel = useCallback(() => abortRef.current?.abort(), []);

  // Follow the stream to the bottom as new content arrives — but only while
  // the user is still parked at the bottom. Keyed on the streaming message's
  // text length (plus activity/sources counts, which also grow the bubble's
  // height) rather than the whole `messages` array, so this doesn't re-fire
  // on unrelated state changes like `feedback`.
  const lastMessage = messages[messages.length - 1];
  const streamingSignature = lastMessage
    ? `${lastMessage.id}:${lastMessage.text.length}:${lastMessage.activity.length}:${lastMessage.sources.length}:${lastMessage.done ? 1 : 0}:${lastMessage.error ? 1 : 0}`
    : "";
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    const el = messageListRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [streamingSignature]);

  return createPortal(
    <motion.div
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[80] bg-[rgba(6,5,4,0.65)] backdrop-blur-[8px]"
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={reduce ? { opacity: 0 } : { opacity: 0, x: "100%" }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, x: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, x: "100%" }}
        transition={
          reduce
            ? { duration: 0.15 }
            : { type: "spring", stiffness: 340, damping: 34 }
        }
        role="dialog"
        aria-modal="true"
        aria-label="Pitwall Assistant"
        className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col apex-glass-strong apex-sheen border-l border-white/10"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="font-[family-name:var(--font-headline)] text-[15px] font-bold text-[var(--color-on-background)]">
              Pitwall Assistant
            </h2>
            <p className="text-[11px] text-[var(--color-on-surface-variant)]">
              Answers from this app&rsquo;s own F1 data, cited as it goes.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-[rgba(16,14,11,0.5)] text-lg text-warm-200 transition-[background-color,transform] duration-150 hover:bg-[rgba(16,14,11,0.7)] active:scale-90"
          >
            ×
          </button>
        </div>

        <div
          ref={messageListRef}
          onScroll={handleMessageListScroll}
          className="flex-1 space-y-4 overflow-y-auto px-5 py-5"
        >
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-[var(--color-on-surface-variant)]">
                Ask about a race, a driver, a season, or F1 history.
              </p>
              <div className="flex flex-col gap-2">
                {suggestionsForPath(pathname ?? "/").map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => ask(suggestion)}
                    className="rounded-lg border border-white/10 bg-[var(--color-surface-container-low)] px-3 py-2 text-left text-xs text-[var(--color-on-surface-variant)] transition-colors duration-150 hover:border-white/20 hover:text-[var(--color-on-surface)]"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message, index) => (
            <MessageBubble
              key={message.id}
              message={message}
              onVote={onVote}
              onRetry={ask}
              running={running}
              liveElapsedSec={
                running && index === messages.length - 1 ? elapsedSec : null
              }
            />
          ))}
        </div>

        <div className="flex gap-2 border-t border-white/10 p-3">
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            disabled={running}
            className="flex-1 rounded-lg bg-transparent px-3 py-2 text-sm text-[var(--color-on-surface)] outline-none placeholder:text-[var(--color-on-surface-variant)]"
            placeholder="Ask about a race, a driver, a season…"
          />
          <button
            onClick={running ? cancel : send}
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-[var(--color-on-primary)] transition-transform duration-150 active:scale-[0.97] disabled:opacity-50"
            disabled={!running && !input.trim()}
          >
            {running ? "Cancel" : "Ask"}
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
}

function MessageBubble({
  message,
  onVote,
  onRetry,
  running,
  liveElapsedSec,
}: {
  message: Message;
  onVote: (messageId: string, runId: string, score: 1 | -1, comment?: string) => void;
  // CP70: Retry and Regenerate are functionally identical — both just
  // re-submit `message.question` through the same `ask` path. One prop
  // covers both call sites rather than plumbing two names for one function.
  onRetry: (question: string) => void;
  // Disables Retry/Regenerate while a turn is already in flight, the same
  // guard `ask` itself applies internally — this just keeps the button from
  // looking clickable when it would be a no-op.
  running: boolean;
  // CP70: seconds elapsed for this turn while it's still in flight
  // (`null` once settled or if this isn't the active turn). `message.done`
  // carries the server-settled `elapsed_ms` once the turn completes, which
  // takes precedence over this client-ticked figure — see `ElapsedIndicator`.
  liveElapsedSec?: number | null;
}) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <p className="max-w-[85%] rounded-2xl bg-[var(--color-primary)] px-4 py-2 text-sm text-[var(--color-on-primary)]">
          {message.text}
        </p>
        <span className="pr-1 text-[10px] text-[var(--color-on-surface-variant)]">
          <LocalDateTime
            timestampMs={message.timestampMs}
            options={{ hour: "2-digit", minute: "2-digit", hour12: false }}
          />
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ElapsedIndicator done={message.done} liveElapsedSec={liveElapsedSec} />

      {message.activity.length > 0 && (
        <ActivityTimeline activity={message.activity} />
      )}

      {message.error ? (
        <div className="flex max-w-[85%] flex-col items-start gap-2">
          <p className="rounded-2xl border border-[var(--color-error)]/40 bg-[var(--color-error-container)]/20 px-4 py-2 text-sm text-[var(--color-error)]">
            {/* `refused` already carries a real, specific message from the
                backend (CP67 guardrails) — only codes missing good copy of
                their own fall back to `ERROR_COPY`. */}
            {message.error.code === "refused"
              ? message.error.message
              : ERROR_COPY[message.error.code as keyof typeof ERROR_COPY] ??
                message.error.message}
          </p>
          {message.question && (
            <button
              type="button"
              onClick={() => onRetry(message.question!)}
              disabled={running}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[rgba(16,14,11,0.5)] px-3 py-1.5 text-xs font-medium text-warm-200 transition-[background-color,transform] duration-150 hover:bg-[rgba(16,14,11,0.7)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
            >
              <RetryIcon />
              Retry
            </button>
          )}
        </div>
      ) : (
        message.text && (
          <div className="max-w-[85%] rounded-2xl border border-white/10 bg-[rgba(26,22,19,0.98)] px-4 py-3 text-sm leading-relaxed text-[var(--color-on-surface)] [&_p]:mb-2 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
            <ReactMarkdown components={{ a: CitationPill }}>
              {rewriteCitations(message.text)}
            </ReactMarkdown>
            <StatusFooter done={message.done} />
          </div>
        )
      )}

      {!message.error && message.done && (
        <div className="flex items-center gap-1.5">
          <CopyButton text={message.text} />
          {message.question && (
            <button
              type="button"
              onClick={() => onRetry(message.question!)}
              disabled={running}
              aria-label="Regenerate answer"
              title="Regenerate"
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-on-surface-variant)] transition-[background-color,color,transform] duration-150 hover:bg-white/5 hover:text-[var(--color-on-surface)] active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40"
            >
              <RetryIcon />
            </button>
          )}
        </div>
      )}

      {!message.error && message.done && (
        <FeedbackControls
          runId={message.done.run_id}
          feedback={message.feedback}
          echoMode={message.done.mode === "echo"}
          onVote={(score, comment) => {
            if (!message.done?.run_id) return;
            onVote(message.id, message.done.run_id, score, comment);
          }}
        />
      )}

      {message.sources.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {message.sources.map((source) => (
            <SourceCard key={source.id} source={source} />
          ))}
        </div>
      )}

      {(message.text || message.error) && (
        <span className="pl-1 text-[10px] text-[var(--color-on-surface-variant)]">
          <LocalDateTime
            timestampMs={message.timestampMs}
            options={{ hour: "2-digit", minute: "2-digit", hour12: false }}
          />
        </span>
      )}
    </div>
  );
}

/**
 * A completed step's marker, encoded redundantly by shape + color + size (not
 * size alone — at 10-11px text a 0.5px size delta doesn't reliably read) so
 * "agent" (a subagent delegation), "tool" (a single tool call) and "system"
 * (housekeeping) stay distinguishable without relying on color perception
 * alone: agent is a small rounded square in the secondary color, tool is the
 * plain round dot this timeline already used, system is the same dot dimmed
 * down so routine housekeeping recedes instead of competing for attention.
 */
function ActivityMarker({ kind }: { kind: ActivityEntry["kind"] }) {
  if (kind === "agent") {
    return <span className="h-1.5 w-1.5 rounded-[2px] bg-[var(--color-secondary)]" />;
  }
  if (kind === "system") {
    return <span className="h-1 w-1 rounded-full bg-[var(--color-warm-500)]/40" />;
  }
  return <span className="h-1 w-1 rounded-full bg-[var(--color-warm-500)]" />;
}

/**
 * Every step the assistant took, in order — not just the ones still
 * in-flight. `key` includes the index because the same label can legitimately
 * appear twice (a repaired draft re-running a step), and React needs a
 * stable-but-distinct key per occurrence, not per label.
 */
function ActivityTimeline({ activity }: { activity: ActivityEntry[] }) {
  return (
    <ul className="space-y-1 text-xs text-[var(--color-warm-500)]">
      {activity
        .filter((entry) => entry.state === "done")
        .map((entry, index) => (
          <li key={`${entry.label}-${index}`} className="flex items-center gap-1.5">
            <ActivityMarker kind={entry.kind} />
            {entry.label}
            {entry.detail && (
              <span className="text-[var(--color-on-surface-variant)]"> — {entry.detail}</span>
            )}
          </li>
        ))}
      {activity
        .filter(
          (entry, index) =>
            entry.state === "start" &&
            !activity
              .slice(index + 1)
              .some((later) => later.label === entry.label && later.state === "done")
        )
        .map((entry, index) => (
          <li key={`active-${entry.label}-${index}`} className="flex items-center gap-1.5">
            <span className="h-1 w-1 animate-pulse rounded-full bg-[var(--color-primary)]" />
            {entry.label}…
            {entry.detail && (
              <span className="text-[var(--color-on-surface-variant)]"> — {entry.detail}</span>
            )}
          </li>
        ))}
    </ul>
  );
}

/**
 * Small "Xs" elapsed-time readout (CP70) shown while a turn is in flight,
 * in the same unobtrusive muted-text style as the rest of this panel's
 * metadata. Prefers the server-settled `done.elapsed_ms` once available —
 * the client-side interval is only trusted up until `done` arrives, per the
 * plan's own reasoning (a client clock can drift; the server's own figure
 * is the source of truth for the final number).
 */
function ElapsedIndicator({
  done,
  liveElapsedSec,
}: {
  done: AgentDone | null;
  liveElapsedSec?: number | null;
}) {
  if (done) {
    return (
      <span className="text-[10px] text-[var(--color-on-surface-variant)]">
        {Math.round(done.elapsed_ms / 1000)}s
      </span>
    );
  }
  if (liveElapsedSec == null) return null;
  return (
    <span className="text-[10px] text-[var(--color-on-surface-variant)]">
      {liveElapsedSec}s
    </span>
  );
}

/**
 * Copy-to-clipboard for a completed answer (CP70). A small icon button that
 * swaps to a checkmark for ~1.5s on success — the same "brief transient
 * confirmation" idea `CitationPill`'s flash-class already established for
 * this panel, but built as local state here rather than a DOM class toggle,
 * since this needs to swap the rendered icon itself, not just a background
 * flash. `emil-design-eng`: 150ms ease-out on the icon swap, `scale(0.94)`
 * on `:active` for press feedback, sized to match `Regenerate`'s 24px
 * hit target so the two sit flush in the same row.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — silently
      // no-op rather than surfacing a second error UI over an already-shown
      // answer; the user can still select-and-copy manually.
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy answer"}
      title={copied ? "Copied" : "Copy"}
      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-on-surface-variant)] transition-[background-color,color,transform] duration-150 hover:bg-white/5 hover:text-[var(--color-on-surface)] active:scale-[0.94]"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 1 2.64 6.36" />
      <polyline points="3 18 3 12 9 12" />
    </svg>
  );
}

/** The `mode`/`tier`/`verification` badges — plain, honest, unobtrusive. */
function StatusFooter({ done }: { done: AgentDone | null }) {
  if (!done) return null;
  if (done.mode === "echo") {
    return (
      <p className="mt-2 text-xs text-[var(--color-error)]">
        Echo mode — inference is not configured, this is not a real answer.
      </p>
    );
  }
  if (done.verification !== "verification_failed") return null;
  return (
    <p className="mt-2 text-xs text-[var(--color-on-surface-variant)]">
      Some details in this answer could not be fully verified against
      retrieved data.
    </p>
  );
}

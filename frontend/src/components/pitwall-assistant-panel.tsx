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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  streamChat,
  postFeedback,
  ERROR_COPY,
  type AgentAnchor,
  type AgentDone,
  type AgentSource,
} from "@/lib/agent-api";
import { buildAnchoredMarkdown } from "@/lib/answer-anchors";
import AnchorMark, { AnchorContext } from "./anchor-mark";
import SourceStrip from "./source-strip";
import LocalDateTime from "./local-datetime";
import FeedbackControls from "./feedback-controls";
import { ActivityAccordion, type ActivityEntry } from "./activity-accordion";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  activity: ActivityEntry[];
  sources: AgentSource[];
  // CP74: the flat, draft-ordered anchor list, arriving on the same `sources`
  // frame. Kept alongside `sources` rather than flattened out of them so the
  // inline marks read draft order directly — regrouping per record and then
  // re-sorting would be a second copy of an ordering the backend already made.
  anchors: AgentAnchor[];
  done: AgentDone | null;
  // CP75: follow-up chips, arriving on their own SSE frame *after* `done`.
  // Stored on the message rather than in a single panel-level slot so an
  // older answer keeps its own chips when the reader scrolls back up — and so
  // a new turn cannot retroactively change what a settled answer offered.
  // Always non-empty when present: the backend omits the frame rather than
  // sending an empty list, so there is no "zero chips" state to render.
  suggestions: string[];
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
  // Set when the reader pressed Cancel — a THIRD way a turn can end, alongside
  // `done` and `error`.
  //
  // Without it, aborting left a message with neither: `settled` stayed false,
  // so the activity timeline pulsed "Thinking..." forever, and Copy,
  // Regenerate, the feedback controls and Retry all render only on a settled
  // message, so the reader was left with a permanently-working bubble they
  // could not retry or dismiss. The abort itself was always correct — the
  // backend frees its concurrency slot and the quota is genuinely saved — it
  // was only the aftermath in the UI that was missing.
  cancelled: boolean;
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

/**
 * The one look a suggested prompt has in this panel, shared by CP70's
 * empty-state list and CP75's post-answer follow-up chips.
 *
 * Hoisted into a constant rather than copied because the two surfaces are the
 * same affordance at two moments — "here is something you could ask" before
 * the first question and after the last answer — and CP74's whole complaint
 * about CP71's citations was two surfaces derived independently drifting
 * apart. Only the layout differs at the call sites (a full-width stack in the
 * empty state, where vertical room is free; a wrapped row under an answer,
 * where four full-width buttons would out-weigh the answer itself).
 *
 * Warm-orange glassmorphism tokens throughout, matching the panel's other
 * secondary controls: the same `border-white/10` hairline, the same
 * `surface-container-low` fill, brightening to `on-surface` on hover, with the
 * 150ms transition and `active:scale` press feedback this panel uses
 * everywhere else. `disabled:` states are spelled out because a chip is
 * genuinely inert while another turn is in flight.
 */
const SUGGESTION_CHIP_CLASS =
  "rounded-lg border border-white/10 bg-[var(--color-surface-container-low)] px-3 py-2 text-left text-xs text-[var(--color-on-surface-variant)] transition-[color,border-color,transform] duration-150 hover:border-white/20 hover:text-[var(--color-on-surface)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";

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
  /**
   * The assistant message the in-flight turn is writing into.
   *
   * `cancel` needs it to settle the right bubble, and it is a ref rather than
   * state for the same reason `abortRef` is: it is read inside a callback that
   * must not re-create itself every turn.
   */
  const runningMessageId = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Auto-scroll-while-streaming (CP70). A ref, not state — this is read on
  // every scroll tick and every token, and re-rendering the whole panel on
  // each scroll pixel would be wasteful. `true` until the user scrolls away
  // from the bottom themselves; sending a new question always resets it,
  // since submitting implies "show me the answer".
  const messageListRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  // Focus trap (CP70). `dialogRef` scopes the Tab-cycle query to the dialog's
  // own subtree; `previouslyFocusedRef` captures whatever had focus on the
  // page (typically the launcher button) so it can be restored on close —
  // hand-rolled per the plan's default (no focus-trap library in this
  // codebase's dependencies), sitting alongside the existing Escape listener
  // below rather than as a separate effect, since both need the same
  // single `keydown` subscription's lifecycle.
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Elapsed-time indicator (CP70). Purely client-side and independent of the
  // backend SSE heartbeat — `Date.now()` at submit time, ticked every second
  // via `setInterval` while a turn is in flight. Once `done` arrives we stop
  // trusting the client clock and switch to `AgentDone.elapsed_ms`, the
  // server's own settled figure, which is why this is `number | null` rather
  // than derived purely from a start-time ref: `null` means "no turn
  // in flight and nothing to show".
  const [elapsedSec, setElapsedSec] = useState<number | null>(null);
  // CP71 (5c): the inline "Discard this conversation?" confirmation state for
  // the New chat control. Only ever true for a non-empty thread.
  const [confirmingNewChat, setConfirmingNewChat] = useState(false);
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
    // Capture whatever had focus before this panel opened (the launcher
    // button, in the normal flow) so it can be restored on close — a plain
    // dialog close that leaves focus nowhere (or resets it to `<body>`)
    // strands keyboard/screen-reader users at the top of the page instead of
    // back where they were.
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const FOCUSABLE_SELECTOR =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Tab never escapes the dialog: wrap from last→first (or first→last
      // going backwards), and treat focus that's somehow already outside the
      // dialog (e.g. a programmatic blur) the same as being "at the edge" so
      // it snaps back in rather than staying lost on the page behind it.
      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        e.preventDefault();
        first.focus();
      }
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
      previouslyFocusedRef.current?.focus();
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
        anchors: [],
        done: null,
        suggestions: [],
        error: null,
        timestampMs: Date.now(),
        feedback: null,
        question: null,
        cancelled: false,
      };
      const assistantId = newId();
      const assistantMessage: Message = {
        id: assistantId,
        role: "assistant",
        text: "",
        activity: [],
        sources: [],
        anchors: [],
        done: null,
        suggestions: [],
        error: null,
        timestampMs: Date.now(),
        feedback: null,
        question: trimmed,
        cancelled: false,
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      runningMessageId.current = assistantId;
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
          onSources: (sources, anchors) => patch((m) => ({ ...m, sources, anchors })),
          onDone: (done) => patch((m) => ({ ...m, done })),
          onSuggestions: (suggestions) => patch((m) => ({ ...m, suggestions })),
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
          runningMessageId.current = null;
          setRunning(false);
        });
    },
    [running, patchMessage, stopElapsedTimer]
  );

  const send = useCallback(() => ask(input), [ask, input]);
  /**
   * Stop the in-flight turn AND settle its bubble.
   *
   * The abort has to be paired with a state change, because aborting alone
   * leaves the message with no `done` and no `error` — see `Message.cancelled`
   * for what that produced. The id is captured from the ref rather than passed
   * in so the button stays a bare `onClick={cancel}`.
   */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    const id = runningMessageId.current;
    if (id) patchMessage(id, (m) => ({ ...m, cancelled: true }));
  }, [patchMessage]);

  /**
   * New chat (CP71, 5c) — this reverses CP70's "thread-per-open, no reset
   * affordance" decision on the user's direct request; `HANDOFF.md` records
   * the reversal and its trigger.
   *
   * Clearing the client's `messages` alone would be a lie: the backend
   * checkpointer keys memory on `thread_id`, so a "cleared" panel that kept
   * sending the old id would still answer with the old conversation in
   * context. The id is regenerated with the same `crypto.randomUUID()` the
   * initial mount uses, so a new chat is genuinely a new thread server-side.
   *
   * A one-tap wipe of a long thread has no undo, so a non-empty conversation
   * asks first — inline in the header rather than via `window.confirm`, whose
   * native dialog would be the only unstyled surface in the panel and would
   * steal focus out of the dialog's own trap.
   */
  const startNewChat = useCallback(() => {
    abortRef.current?.abort();
    stopElapsedTimer();
    setRunning(false);
    setElapsedSec(null);
    setMessages([]);
    setInput("");
    setConfirmingNewChat(false);
    threadId.current = crypto.randomUUID();
    isAtBottomRef.current = true;
    inputRef.current?.focus();
  }, [stopElapsedTimer]);

  const requestNewChat = useCallback(() => {
    if (messages.length === 0) {
      startNewChat();
      return;
    }
    setConfirmingNewChat(true);
  }, [messages.length, startNewChat]);

  // Follow the stream to the bottom as new content arrives — but only while
  // the user is still parked at the bottom. Keyed on the streaming message's
  // text length (plus activity/sources counts, which also grow the bubble's
  // height) rather than the whole `messages` array, so this doesn't re-fire
  // on unrelated state changes like `feedback`.
  const lastMessage = messages[messages.length - 1];
  const streamingSignature = lastMessage
    ? // `suggestions.length` is in here because CP75's chips land *after*
      // `done` and grow the bubble again once it looked settled — without it
      // the follow-ups render just below the fold and the reader never learns
      // they exist.
      `${lastMessage.id}:${lastMessage.text.length}:${lastMessage.activity.length}:${lastMessage.sources.length}:${lastMessage.suggestions.length}:${lastMessage.done ? 1 : 0}:${lastMessage.error ? 1 : 0}`
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
        ref={dialogRef}
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
          <div className="flex items-center gap-1.5">
            {/* New chat. Icon-only at 34px to match the close button's hit
                target — a text button here would compete with the panel
                title, and this is a secondary, occasional action. */}
            <button
              onClick={requestNewChat}
              aria-label="New chat"
              title="New chat"
              className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-[rgba(16,14,11,0.5)] text-warm-200 transition-[background-color,transform] duration-150 hover:bg-[rgba(16,14,11,0.7)] active:scale-90"
            >
              <NewChatIcon />
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-[rgba(16,14,11,0.5)] text-lg text-warm-200 transition-[background-color,transform] duration-150 hover:bg-[rgba(16,14,11,0.7)] active:scale-90"
            >
              ×
            </button>
          </div>
        </div>

        {/* Exit is animated too (and faster than the enter, 120ms vs 180ms):
            the bar snapping out of existence on "Keep" reads as a glitch, and
            once the user has decided the system should get out of the way. */}
        <AnimatePresence initial={false}>
          {confirmingNewChat && (
          <motion.div
            key="confirm-new-chat"
            initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={
              reduce
                ? { opacity: 0 }
                : { opacity: 0, height: 0, transition: { duration: 0.12, ease: [0.23, 1, 0.32, 1] } }
            }
            transition={{ duration: reduce ? 0.1 : 0.18, ease: [0.23, 1, 0.32, 1] }}
            className="flex items-center gap-2 overflow-hidden border-b border-white/10 bg-[rgba(16,14,11,0.4)] px-5 py-2.5"
          >
            <p className="flex-1 text-[11px] text-[var(--color-on-surface-variant)]">
              Start a new chat? This conversation will be discarded.
            </p>
            <button
              onClick={() => setConfirmingNewChat(false)}
              className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-[var(--color-on-surface-variant)] transition-[color,transform] duration-150 hover:text-[var(--color-on-surface)] active:scale-[0.97]"
            >
              Keep
            </button>
            <button
              onClick={startNewChat}
              className="rounded-lg bg-[var(--color-primary)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-on-primary)] transition-transform duration-150 active:scale-[0.97]"
            >
              New chat
            </button>
          </motion.div>
          )}
        </AnimatePresence>

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
                    type="button"
                    onClick={() => ask(suggestion)}
                    className={SUGGESTION_CHIP_CLASS}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
              {/* Say that the conversation is disposable, because nothing else
                  does.
                  `threadId` is a fresh UUID on every mount and the launcher
                  only mounts this panel while it is open, so closing the panel
                  — not just reloading — discards the conversation. The
                  deliberate reset ("Start a new chat? This conversation will be
                  discarded") warns before doing exactly the same thing, which
                  makes the silent version more surprising, not less. One line
                  here is cheaper than persistence and honest about what the
                  product is. */}
              <p className="pt-1 text-[11px] text-[var(--color-on-surface-variant)]">
                Conversations aren&apos;t saved — closing this panel starts a
                fresh one.
              </p>
            </div>
          )}
          {messages.map((message, index) => (
            <MessageBubble
              key={message.id}
              message={message}
              onVote={onVote}
              onAsk={ask}
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

/**
 * Memoised on purpose. `messages.map` re-renders every bubble on every
 * `setMessages` — i.e. once per streamed token — and a bubble with an open
 * citation popover would rebuild that popover's props at token rate. Only the
 * streaming bubble's props actually change, so shallow equality here keeps
 * settled bubbles (and any popover they own) entirely still.
 */
const MessageBubble = memo(function MessageBubble({
  message,
  onVote,
  onAsk,
  running,
  liveElapsedSec,
}: {
  message: Message;
  onVote: (messageId: string, runId: string, score: 1 | -1, comment?: string) => void;
  // CP70: Retry and Regenerate are functionally identical — both just
  // re-submit `message.question` through the same `ask` path. One prop
  // covers both call sites rather than plumbing two names for one function.
  // CP75 renamed it from `onRetry`: the follow-up chips are a third caller
  // and they are not a retry of anything — this is simply "ask this", and a
  // prop named for one of its three uses reads as a bug at the other two.
  onAsk: (question: string) => void;
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
  // CP74: one pass turns the raw draft into renderable markdown and reports
  // which anchors survived. Both the marks and the context read that single
  // result, so an anchor the rewrite dropped cannot be one the popover thinks
  // exists. Memoised on the two inputs it actually depends on — it runs on
  // every streamed token otherwise, and during streaming `anchors` is still
  // empty anyway (the `sources` frame arrives at the end).
  const anchored = useMemo(
    () => buildAnchoredMarkdown(message.text, message.anchors, message.id),
    [message.text, message.anchors, message.id]
  );
  const anchorContextValue = useMemo(
    () => ({
      messageId: message.id,
      sources: message.sources,
      anchors: anchored.resolved,
      // The marker-stripped text, not the raw draft: this is what the reader
      // sees, and `CitationPopover`'s snippet-highlight fallback asks "does
      // the answer literally contain this value".
      answerText: anchored.plainText,
    }),
    [message.id, message.sources, anchored.resolved, anchored.plainText]
  );

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
      {/* Once settled, the accordion's summary row already carries the
          elapsed time — showing it twice reads as a rendering bug. The
          standalone readout stays for the in-flight case and for a turn that
          produced no activity steps at all. */}
      {!(message.done && message.activity.length > 0) && (
        <ElapsedIndicator done={message.done} liveElapsedSec={liveElapsedSec} />
      )}

      {/* CP71: the timeline collapses once the turn settles — no stale
          "Thinking…" sitting next to a finished answer. `settled` is
          `done || error` because a failed turn is just as finished as a
          successful one. */}
      <ActivityAccordion
        activity={message.activity}
        settled={Boolean(message.done || message.error || message.cancelled)}
        elapsedLabel={
          message.done ? `${Math.round(message.done.elapsed_ms / 1000)}s` : undefined
        }
      />

      {message.error ? (
        <div className="flex max-w-[85%] flex-col items-start gap-2">
          <p className="rounded-2xl border border-[var(--color-error)]/40 bg-[var(--color-error-container)]/20 px-4 py-2 text-sm text-[var(--color-error)]">
            {/* The SENT message wins; `ERROR_COPY` is the fallback.
                This used to be the other way round, and the inversion made the
                backend's error copy unreachable in production. `refused` was
                deliberately excluded so a guardrail's specific refusal could
                show through — but every OTHER code has an entry in the map, so
                the `??` fallback could never fire for anything except
                `refused`, and the map's generic apology always won.
                What it was hiding is worth reading: `main.py` distinguishes a
                queue timeout ("yours waited 31s for a turn without getting
                one"), a research-budget timeout ("a narrower question — one
                driver, one season, one race — will usually get through") and
                an exhausted daily allowance ("resets within a few hours, and
                cached answers still work in the meantime"), and the rate
                limiter adds two more. All five were being flattened into "The
                assistant is busy right now". */}
            {message.error.message ||
              ERROR_COPY[message.error.code as keyof typeof ERROR_COPY] ||
              "Something went wrong reaching the assistant."}
          </p>
          {message.question && (
            <button
              type="button"
              onClick={() => onAsk(message.question!)}
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
          <div
            aria-live="polite"
            aria-atomic="false"
            className={`max-w-[85%] min-w-0 rounded-2xl border border-white/10 bg-[rgba(26,22,19,0.98)] px-4 py-3 text-sm leading-relaxed text-[var(--color-on-surface)] ${ANSWER_PROSE}`}
          >
            {/* A mark needs this message's identity, evidence and resolved
                anchors, and `react-markdown` gives a `components.a` override
                no way to receive props — hence context rather than a prop. */}
            <AnchorContext.Provider value={anchorContextValue}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{ a: AnchorMark, table: MarkdownTable }}
              >
                {anchored.markdown}
              </ReactMarkdown>
            </AnchorContext.Provider>
            <StatusFooter done={message.done} />
          </div>
        )
      )}

      {/* A stopped turn says so, and offers the way back.
          Rendered outside the error/text branch above because cancelling is
          neither: the reader may have stopped it before any text arrived (the
          common case, since the draft is replayed in one burst at the end) or
          part-way through, and both need the same two things — an explanation
          that the silence is deliberate, and a Retry. Without this the bubble
          simply stopped, with every control that appears on a settled message
          absent. */}
      {message.cancelled && !message.error && (
        <div className="flex max-w-[85%] flex-col items-start gap-2">
          <p className="font-medium text-xs text-warm-500">
            Stopped. {message.text ? "This answer is incomplete." : "No answer was written."}
          </p>
          {message.question && (
            <button
              type="button"
              onClick={() => onAsk(message.question!)}
              disabled={running}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[rgba(16,14,11,0.5)] px-3 py-1.5 text-xs font-medium text-warm-200 transition-[background-color,transform] duration-150 hover:bg-[rgba(16,14,11,0.7)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
            >
              <RetryIcon />
              Ask again
            </button>
          )}
        </div>
      )}

      {!message.error && message.done && (
        <div className="flex items-center gap-1.5">
          <CopyButton text={message.text} />
          {message.question && (
            <button
              type="button"
              onClick={() => onAsk(message.question!)}
              disabled={running}
              aria-label="Regenerate answer"
              title="Regenerate"
              className="relative before:absolute before:-inset-2 before:content-[''] flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-on-surface-variant)] transition-[background-color,color,transform] duration-150 hover:bg-white/5 hover:text-[var(--color-on-surface)] active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40"
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

      {/* An answer with NO evidence must say so.
          `SourceStrip` renders nothing when `sources` is empty and
          `StatusFooter` renders nothing when verification passed -- and an
          "empty-ish" draft passes by design. So a confident, entirely
          uncited paragraph arrived looking identical to a fully cited one,
          minus two absences, and the absence of a strip is not something a
          reader notices. Stating it turns a silent gap into a claim the
          reader can weigh. */}
      {message.done &&
        !message.error &&
        message.sources.length === 0 &&
        message.text && (
          <p className="pl-1 text-[11px] text-[var(--color-on-surface-variant)]">
            No stored records backed this answer — it is the model&apos;s own
            account.
          </p>
        )}

      <SourceStrip
        sources={message.sources}
        messageId={message.id}
        resolved={anchored.resolved}
      />

      <FollowUpChips
        suggestions={message.suggestions}
        onAsk={onAsk}
        running={running}
      />

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
});

/**
 * CP75's follow-up chips — three or four things to ask next, under a finished
 * answer. Clicking one sends it as a user message, exactly as if typed, which
 * is why it goes through the same `ask` the input box uses rather than a
 * parallel path.
 *
 * Renders nothing for an empty list, which is the normal outcome whenever the
 * model's suggestions failed to generate or the backend's router dropped all
 * of them. The feature is additive: no chips is a state, not a failure, and it
 * gets no placeholder, no skeleton and no apology.
 *
 * Presentation is CP70's empty-state suggestions at a different density —
 * `SUGGESTION_CHIP_CLASS` is literally the same string — because they are the
 * same affordance offered at two moments. The layout differs: a wrapped row
 * here, since four full-width buttons stacked under an answer would out-weigh
 * the answer itself, and these arrive *after* the reader has already got what
 * they asked for.
 *
 * Accessibility, per CP70/CP71/CP74's work in this panel: every chip is a real
 * `<button>`, so it is in the Tab order and inside the dialog's focus trap for
 * free, and it carries a visible `focus-visible` ring. The group is a labelled
 * `<nav>`-less region — `role="group"` with an `aria-label` — so a screen
 * reader announces what this cluster of buttons is before reading four
 * questions that would otherwise sound like part of the answer. `aria-label`
 * on each button restates the action ("Ask: …") because the bare text is a
 * question, and a question read out in a button list is ambiguous about
 * whether it is being asked *of* the reader.
 */
function FollowUpChips({
  suggestions,
  onAsk,
  running,
}: {
  suggestions: string[];
  onAsk: (question: string) => void;
  // A chip is genuinely inert while another turn is in flight — `ask` itself
  // no-ops in that case, so an enabled-looking button would silently do
  // nothing. Same guard Retry/Regenerate already apply.
  running: boolean;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Suggested follow-up questions"
      className="flex flex-col gap-1.5 pt-0.5"
    >
      <p className="text-[10px] uppercase tracking-wide text-[var(--color-on-surface-variant)]">
        Ask next
      </p>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onAsk(suggestion)}
            disabled={running}
            aria-label={`Ask: ${suggestion}`}
            className={SUGGESTION_CHIP_CLASS}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A markdown table, wrapped in its own horizontal scroller (CP71, 5d).
 *
 * A results table with six columns is wider than a 480px drawer, and an
 * unwrapped `<table>` stretches its container: the whole bubble — and with it
 * the message list — grows a horizontal scrollbar, which is how a chat panel
 * ends up feeling broken. Scrolling the table alone keeps the overflow where
 * it belongs. `min-w-0` on the bubble is the other half of this: without it a
 * flex child refuses to shrink below its content and the clamp never applies.
 */
function MarkdownTable({ children }: { children?: React.ReactNode }) {
  return (
    <div className="my-2 max-w-full overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  );
}

/**
 * Prose styling for an answer bubble (CP71, 5d). Arbitrary descendant variants
 * rather than `@tailwindcss/typography`: the plugin is not a dependency here,
 * and its defaults are tuned for article width, not a 480px drawer at 14px.
 *
 * `emil-design-eng` notes: vertical rhythm is one consistent step (`mb-2`)
 * with the last child zeroed so the bubble never carries a phantom bottom
 * gutter; headings step down in weight and size only slightly (an `h1` inside
 * a chat answer is a paragraph lead, not a page title) and use the headline
 * family already in the design system; `code` gets a tint rather than a border
 * so inline code does not disturb the line box; blockquotes use a left rule in
 * the primary accent at low alpha — quiet, and the same language the rest of
 * the app uses for aside content.
 */
const ANSWER_PROSE = [
  "[&_p]:mb-2 [&_p:last-child]:mb-0",
  "[&_strong]:font-semibold [&_em]:italic",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1",
  "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-1",
  "[&_li]:leading-relaxed [&_li>ul]:my-1 [&_li>ol]:my-1",
  "[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-[15px] [&_h1]:font-bold [&_h1]:font-[family-name:var(--font-headline)]",
  "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-[14px] [&_h2]:font-bold [&_h2]:font-[family-name:var(--font-headline)]",
  "[&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:uppercase [&_h3]:tracking-wide [&_h3]:text-[var(--color-on-surface-variant)]",
  "[&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0",
  "[&_code]:rounded [&_code]:bg-white/[0.07] [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] [&_code]:font-mono",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-white/10 [&_pre]:bg-[rgba(10,9,7,0.7)] [&_pre]:p-2.5",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[11.5px] [&_pre_code]:leading-relaxed",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-primary)]/40 [&_blockquote]:pl-3 [&_blockquote]:text-[var(--color-on-surface-variant)]",
  "[&_hr]:my-3 [&_hr]:border-white/10",
  "[&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-white/10 [&_th]:bg-white/[0.04] [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:font-semibold [&_th]:text-[var(--color-on-surface-variant)]",
  "[&_td]:whitespace-nowrap [&_td]:border-b [&_td]:border-white/[0.06] [&_td]:px-2.5 [&_td]:py-1.5",
  "[&_tr:last-child_td]:border-b-0",
].join(" ");

/** Header affordance for 5c — a speech bubble with a "+". */
function NewChatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      <line x1="12" y1="8" x2="12" y2="14" />
      <line x1="9" y1="11" x2="15" y2="11" />
    </svg>
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
      className="relative before:absolute before:-inset-2 before:content-[''] flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-on-surface-variant)] transition-[background-color,color,transform] duration-150 hover:bg-white/5 hover:text-[var(--color-on-surface)] active:scale-[0.94]"
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
  // Styled as a warning, not a footnote.
  //
  // This fires when the verifier found a specific problem -- a citation
  // pointing at a record that was never retrieved, a number absent from the
  // record cited for it, or a meaningful number with no citation at all -- AND
  // the model's one repair attempt failed to fix it. The answer is still shown,
  // which is the right call, but it was announced in the same muted grey as the
  // elapsed-time readout beside it, quieter than the metadata. A reader
  // scanning the answer had no reason to read it as anything but chrome.
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-[var(--color-error)]">
      <span className="material-symbols-outlined text-[15px] leading-none" aria-hidden="true">
        warning
      </span>
      <span>
        Some figures here could not be matched to a stored record. Check them
        before relying on them.
      </span>
    </p>
  );
}

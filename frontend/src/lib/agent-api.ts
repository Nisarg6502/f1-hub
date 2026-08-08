/**
 * Client for the `f1-agent` chat service (CP59).
 *
 * The service streams Server-Sent Events from `POST /api/chat`. The event
 * vocabulary is defined and tested on the backend in `backend/agent/sse.py` —
 * that module is the contract, and the types here mirror it. Any change there
 * has to land here too.
 *
 * `EventSource` is deliberately not used. It only speaks GET, and it silently
 * reconnects on any drop — which for an agent turn would re-run the whole
 * thing and charge a quota we are already rationing. So this reads the
 * response body with a stream reader and parses SSE frames by hand.
 */

const AGENT_BASE_URL =
  process.env.NEXT_PUBLIC_AGENT_BASE_URL ?? "http://localhost:8100";

/** Closed set, mirroring `sse.ERROR_CODES`. The UI styles on these. */
export type AgentErrorCode =
  | "at_capacity"
  | "timeout"
  | "upstream"
  | "bad_request"
  | "refused"
  | "internal";

/**
 * A client-only code (CP70) for the pre-connection network-catch path — not
 * part of the backend's `ERROR_CODES` contract, so kept as a separate union
 * rather than folded into `AgentErrorCode` above.
 */
export type ClientErrorCode = "network";

/**
 * Human-readable copy for error codes that don't already carry a good
 * user-facing message of their own (CP70). `refused` is deliberately left
 * out: CP67's guardrails already attach a real, specific refusal message to
 * that code (e.g. "I can't help with that"), and clobbering it with generic
 * copy here would be a regression, not a fix. Any code missing from this map
 * — including `refused` — should fall back to the message the backend/SSE
 * layer actually sent rather than a canned string.
 */
export const ERROR_COPY: Partial<Record<AgentErrorCode | ClientErrorCode, string>> = {
  at_capacity: "The assistant is busy right now — try again in a moment.",
  timeout: "That took too long to answer. Try again, or ask something more specific.",
  upstream: "Something went wrong reaching the model. Try again shortly.",
  bad_request: "That request couldn't be processed — try rephrasing your question.",
  internal: "Something went wrong on our end. Try again.",
  network: "Couldn't reach the assistant — check your connection and try again.",
};

/**
 * One `{label, value}` pair of the inspectable evidence a citation rests on
 * (CP71 Task 1, `backend/agent/ledger.py::Evidence._snippet`). Capped at 6
 * pairs with values truncated to ~120 chars, so this is safe to ship on every
 * `sources` frame. An EMPTY list is a normal outcome — the backend builder has
 * a catch-all returning `[]` — not an error state.
 */
export interface AgentSnippetPair {
  label: string;
  value: string;
}

/**
 * One claim token tied to the exact field of the exact record proving it
 * (CP72, `backend/agent/verifier.py::Anchor`).
 *
 * `start`/`end` index the **raw draft** — the answer text exactly as it
 * streamed, `[ev_N]` markers included — not the rendered prose. That is the
 * whole reason `answer-anchors.ts` exists: reconciling those offsets against
 * what `ReactMarkdown` finally paints is CP74's hardest problem, and it is
 * solved in one place rather than at each call site.
 *
 * `text` is the draft's own wording; `value` is the stored one. They
 * legitimately differ ("Russell" in the prose, "George Russell" in the
 * record), so the mark uses `text` and the evidence panel uses `value`.
 *
 * Every field is optional-by-defensiveness at the boundary: this arrives over
 * the wire from a heuristic token matcher, and CP44's lesson is that a
 * documented shape is not a guaranteed one.
 */
export interface AgentAnchor {
  evidence_id: string;
  text: string;
  start: number;
  end: number;
  claim?: string;
  field?: string;
  value?: string;
  path?: string;
  row?: Record<string, unknown> | null;
}

export interface AgentSource {
  id: string;
  n: number;
  kind: "data" | "web" | "wikipedia";
  label: string;
  title: string;
  url?: string | null;
  as_of?: string | null;
  /** Optional: an older agent build may not send it at all. */
  snippet?: AgentSnippetPair[] | null;
  /**
   * This record's own anchors, in draft order (CP72). Present so the source
   * strip and the inline marks are two views of ONE set — the structural fix
   * for CP71's "one citation inline, five listed below".
   */
  anchors?: AgentAnchor[] | null;
}

export interface AgentDone {
  run_id: string | null;
  /** `"echo"` means inference was unavailable and the text is NOT an answer. */
  mode: "model" | "echo";
  model: string;
  prompt_version: number;
  /** CP63: the router's tier decision. `null` for the echo fallback. */
  tier: number | null;
  /**
   * CP64: `null` for tier 1 (verification is skipped there by design) and
   * for the echo fallback — only a real tier 2/3 answer carries a value.
   */
  verification: "passed" | "verification_failed" | null;
  elapsed_ms: number;
}

export interface AgentHandlers {
  onActivity?: (
    label: string,
    state: "start" | "done",
    detail?: string | null,
    kind?: "tool" | "agent" | "system"
  ) => void;
  onToken?: (text: string) => void;
  /**
   * CP74: the flat, draft-ordered anchor list arrives alongside the grouped
   * sources because the two are derived from one set backend-side. It is
   * always an array — the backend sends `[]` rather than omitting the key on
   * the paths that have no anchors (echo fallback, cached pre-CP72 answers) —
   * so a caller never has to distinguish "none" from "old build".
   */
  onSources?: (sources: AgentSource[], anchors: AgentAnchor[]) => void;
  onDone?: (done: AgentDone) => void;
  /**
   * CP75's follow-up chips — the one event that arrives **after** `done`.
   *
   * That ordering is deliberate on the backend (`sse.py`): generating them
   * costs a model call, and a reader must never wait on their own chips. It
   * means `onDone` is no longer the last handler a turn fires, so anything
   * that treats `done` as "the stream is finished" must keep reading — which
   * `streamChat`'s loop does anyway, since it reads to EOF rather than
   * stopping on an event name.
   *
   * Never called with an empty array: the backend skips the frame entirely
   * when generation failed or the router dropped every candidate, so "no
   * chips" is the absence of a call rather than a call carrying nothing.
   */
  onSuggestions?: (suggestions: string[]) => void;
  onError?: (code: AgentErrorCode, message: string) => void;
}

export interface AgentHealth {
  status: string;
  service: string;
  model: string;
  inference_configured: boolean;
  langsmith_tracing: boolean;
  prompt_version: number;
  runs: { running: number; waiting: number; limit: number };
}

export async function getAgentHealth(
  signal?: AbortSignal
): Promise<AgentHealth> {
  const res = await fetch(new URL("/health", AGENT_BASE_URL).toString(), {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`agent health ${res.status}`);
  return (await res.json()) as AgentHealth;
}

/**
 * Split a buffer into complete SSE frames, returning the unconsumed remainder.
 *
 * Exported for tests. The remainder matters: a chunk boundary lands in the
 * middle of a frame constantly, and treating a partial frame as complete is
 * how a streaming client drops or mangles tokens.
 */
export function splitFrames(buffer: string): {
  frames: string[];
  rest: string;
} {
  // The SSE spec terminates lines with CRLF, CR *or* LF, and intermediaries
  // rewrite line endings — which is the whole reason this module hand-rolls a
  // parser instead of using EventSource. An LF-only split against a CRLF
  // stream finds no frames at all, so the buffer grows without bound and
  // `streamChat` resolves having called no handler: no answer, no error, and
  // indistinguishable from success to the caller.
  //
  // A trailing "\r" is ambiguous: it may be a complete CR line terminator, or
  // the first half of a "\r\n" straddling a chunk boundary. Normalising it
  // eagerly would turn a single mid-frame CRLF into a "\n\n" frame break and
  // split a frame down the middle.
  //
  // It is only ambiguous, though, when a line is actually open. If the
  // character before it is itself a newline, the preceding line already
  // ended, so this "\r" is the blank line that terminates the frame and must
  // NOT be held back — holding it swallowed the second "\r" of a "\r\r"
  // terminator and lost the final frame of every CR-terminated stream.
  let pending = "";
  let working = buffer;
  if (working.endsWith("\r") && !/[\r\n]\r$/.test(working)) {
    pending = "\r";
    working = working.slice(0, -1);
  }

  const normalised = working.replace(/\r\n|\r/g, "\n");
  const parts = normalised.split("\n\n");
  const rest = (parts.pop() ?? "") + pending;
  return { frames: parts.filter((frame) => frame.length > 0), rest };
}

/** Parse one frame into an event name and payload, or null if it is a comment. */
export function parseFrame(
  frame: string
): { event: string; data: unknown } | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const raw of frame.split(/\r\n|\r|\n/)) {
    if (raw.startsWith(":")) continue;
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    const field = raw.slice(0, colon);
    // The space after the colon is optional in the spec — only one leading
    // space is stripped. Slicing a fixed "event: " length instead drops a
    // real character from any server that omits it.
    let value = raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    // Per the SSE spec multiple `data:` lines in one frame are joined with a
    // newline. The backend only ever emits one, but a client that assumes so
    // breaks silently the first time that stops being true.
    else if (field === "data") dataLines.push(value);
  }
  if (!event) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

/**
 * A `[ev_N]` citation marker as the model actually writes it.
 *
 * **Mirror of `_CITATION_RE` in `backend/agent/verifier.py`.** Keep the two in
 * sync: they parse the same strings out of the same draft, and a frontend that
 * recognises fewer variants than the verifier leaves the extras on screen as
 * raw text — the dead-`[ev_N]` symptom CP68 was supposed to have eliminated.
 *
 * Bracket *shape* is tolerated because CP73's live runs caught the deployed
 * model closing a marker with the CJK full-width `【ev_2】`. The backend was
 * blind to it and reported nine violations against a correct, properly cited
 * draft. This is the CP41 lesson again — the prompt asks for `[ev_N]`, the
 * model mostly complies, and "mostly" is not a contract. Widening the parser
 * costs nothing; asking the model more firmly is the approach CP41 already
 * watched fail in ALL CAPS.
 *
 * Only the brackets are loose. The `ev_N` body stays exact, so a hallucinated
 * id is still a lookup miss rather than a silently-accepted citation. Any
 * opening variant may pair with any closing one, matching the backend
 * character-class-for-character-class rather than requiring a matched pair —
 * a model that mixes `[ev_2】` is doing something no stricter rule predicts.
 *
 * **Streaming safety is a property of the closing bracket being required.** A
 * marker split across a chunk boundary (`"…【ev_"`) simply does not match yet
 * and passes through as literal text until its closing bracket arrives in a
 * later chunk. Any future widening must preserve that.
 */
export const CITATION_MARKER_SOURCE = "[[【［]ev_(\\d+)[\\]】］]";

/**
 * The href an inline anchor mark carries: `#anchor-<messageId>-<index>`.
 *
 * CP74 keeps CP71's transport — a plain string rewrite into a markdown link,
 * rendered through a `components.a` override — because `react-markdown`
 * already parses links correctly and a custom remark plugin would be a new
 * AST-visiting dependency for something a rewrite already solves. What
 * changed is the *payload*: CP71 encoded an evidence id and rendered a
 * numbered pill; CP74 encodes an index into the message's resolved anchor
 * list, because an anchor names a field and a row, which no href could carry.
 *
 * The message id stays in the href for exactly CP71's reason: evidence ids
 * restart at `ev_1` every turn, so anything document-global collides across
 * answers on screen.
 */
export function anchorHref(messageId: string, index: number): string {
  return `#anchor-${messageId}-${index}`;
}

/**
 * Inverse of {@link anchorHref}.
 *
 * The message-id segment is matched greedily and the index is anchored to the
 * end, so this survives any message id that does not itself end in
 * `-<digits>`. Returns `null` for an ordinary markdown link, which is what
 * keeps `AnchorMark`'s plain-link fallback working — an answer containing a
 * genuine external link must still render it as a link.
 */
export function parseAnchorHref(
  href: string | undefined
): { messageId: string; index: number } | null {
  const match = href?.match(/^#anchor-(.+)-(\d+)$/);
  if (!match) return null;
  return { messageId: match[1], index: Number(match[2]) };
}

/** The DOM id a source-strip chip renders and an `AnchorMark` resolves. */
export function citationAnchorId(messageId: string, evidenceId: string): string {
  return `source-${messageId}-${evidenceId}`;
}

/**
 * Send a question and dispatch stream events to `handlers`.
 *
 * Resolves when the stream ends. Never throws for a *service* failure — those
 * arrive as `onError`, because by the time anything goes wrong the response is
 * already committed with status 200. It does throw if the request could not be
 * made at all (network down, CORS refused), which is a genuinely different
 * situation and should not be dressed up as an agent error.
 *
 * Pass `signal` to cancel; aborting stops the LangGraph run server-side rather
 * than leaving it burning quota for a closed tab.
 */
export async function streamChat(
  message: string,
  handlers: AgentHandlers,
  options: { threadId?: string; signal?: AbortSignal } = {}
): Promise<void> {
  const res = await fetch(new URL("/api/chat", AGENT_BASE_URL).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, thread_id: options.threadId ?? null }),
    signal: options.signal,
  });

  if (!res.ok || !res.body) {
    // Release the socket rather than leaving an unread body pinned open.
    await res.body?.cancel().catch(() => {});
    handlers.onError?.(
      "upstream",
      `The assistant is unreachable (HTTP ${res.status}).`
    );
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps a multi-byte character split across a chunk
      // boundary from decoding into a replacement character — routine with
      // driver names like Räikkönen.
      buffer += decoder.decode(value, { stream: true });

      const { frames, rest } = splitFrames(buffer);
      buffer = rest;

      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (!parsed) continue;
        dispatch(parsed.event, parsed.data, handlers);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Record a thumbs up/down on a completed answer (CP69).
 *
 * Fire-and-forget, mirroring `streamChat`'s fetch setup minus the SSE
 * reader — a feedback POST is a single request/response, not a stream. The
 * backend's own contract (`POST /api/feedback`) is fail-soft: it always
 * returns 200 with `{"recorded": bool}`, never a hard error, so there is
 * nothing useful to surface to the user even on failure. Network errors are
 * swallowed here for the same reason — a dropped vote is telemetry loss,
 * not a user-visible error.
 *
 * Callers must not invoke this with a falsy `runId` — the backend's
 * `FeedbackRequest.run_id` is a required, non-optional field and rejects a
 * missing/null value with a 422. The caller (`FeedbackControls`) enforces
 * this by simply not rendering when there's no run id to attach a vote to.
 */
export async function postFeedback(
  runId: string,
  score: 1 | -1,
  comment?: string
): Promise<void> {
  try {
    await fetch(new URL("/api/feedback", AGENT_BASE_URL).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId, score, comment: comment ?? null }),
    });
  } catch {
    // Fire-and-forget telemetry — a failed vote is not a user-visible error.
  }
}

function dispatch(event: string, data: unknown, handlers: AgentHandlers): void {
  const payload = (data ?? {}) as Record<string, unknown>;
  switch (event) {
    case "activity":
      handlers.onActivity?.(
        String(payload.label ?? ""),
        payload.state === "done" ? "done" : "start",
        payload.detail == null ? null : String(payload.detail),
        (payload.kind as "tool" | "agent" | "system" | undefined) ?? "system"
      );
      break;
    case "token":
      handlers.onToken?.(String(payload.text ?? ""));
      break;
    case "sources":
      handlers.onSources?.(
        (payload.sources ?? []) as AgentSource[],
        (payload.anchors ?? []) as AgentAnchor[]
      );
      break;
    case "done":
      handlers.onDone?.(payload as unknown as AgentDone);
      break;
    case "suggestions": {
      // Re-validated at the boundary rather than trusted: the backend already
      // drops anything unroutable, but this arrives over the wire from a
      // model-generated list and CP44's lesson is that a documented shape is
      // not a guaranteed one. A non-array, a nested object, or a stray empty
      // string would each render as a blank, unclickable chip.
      const items = Array.isArray(payload.suggestions)
        ? payload.suggestions
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      if (items.length > 0) handlers.onSuggestions?.(items);
      break;
    }
    case "error":
      handlers.onError?.(
        (payload.code ?? "internal") as AgentErrorCode,
        String(payload.message ?? "Something went wrong.")
      );
      break;
    default:
      // An unknown event is forward compatibility, not an error: a newer
      // service may emit events this build predates.
      break;
  }
}

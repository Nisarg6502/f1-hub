"use client";

/**
 * Dictation (speech-to-text) for the assistant composer — CP77.
 *
 * Built on the browser's own Web Speech API (`SpeechRecognition`, prefixed as
 * `webkitSpeechRecognition` in Chrome/Edge/Safari). No backend, no API key, no
 * audio ever leaves the page through *our* code: the browser owns the capture
 * and the transcription round-trip. That is the whole reason this is a ~200
 * line hook instead of an upload pipeline.
 *
 * Two deliberate constraints shape the API below:
 *
 * - **Final transcripts are committed; interim ones are only previewed.**
 *   The composer is a controlled `<input>` the user can type into *while*
 *   dictating. Writing interim results straight into `value` would fight the
 *   caret and would clobber typed text every time the recognizer revised its
 *   guess. So `onFinalTranscript` fires once per settled phrase (the caller
 *   appends), and `interim` is handed back separately for a live preview line.
 *   Words still appear as they are spoken — they just appear in the preview
 *   until the recognizer is sure, then land in the composer.
 *
 * - **Unsupported means "no feature", not "broken feature".** `supported` is
 *   read through `useSyncExternalStore` with a hard `false` server snapshot, so
 *   the server and the first client render agree (the API is a `window`
 *   property; reading it during render would be a hydration mismatch). Firefox
 *   has no implementation at all, and the caller is expected to render no mic
 *   button rather than one that cannot work.
 *
 * The DOM lib ships no `SpeechRecognition` types, so the minimum surface this
 * hook actually touches is declared locally below — structural interfaces, no
 * dependency, and no `any` casts for lint to trip over.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/* --------------------------------------------------------------------------
   Minimal local typings for the Web Speech API.
   Only the members this hook reads or assigns — this is not an attempt at a
   complete `@types/dom-speech-recognition`.
   -------------------------------------------------------------------------- */

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

function getRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * `en-US` unless the browser is already set to some *other* English locale, in
 * which case that one is a strictly better guess (en-GB spells "colour" and
 * hears British place names). A non-English browser still gets en-US: this
 * app's assistant answers in English and its vocabulary — driver names, circuit
 * names — is English, so transcribing in, say, de-DE would produce nonsense.
 */
function resolveLanguage(): string {
  if (typeof navigator === "undefined") return "en-US";
  const lang = navigator.language;
  return lang && /^en([-_]|$)/i.test(lang) ? lang : "en-US";
}

/**
 * Human copy per spec error code. Short, plain, and specific enough to act on —
 * "blocked" tells you to change a setting, "no microphone" tells you to check
 * hardware, and those are genuinely different next steps.
 *
 * `aborted` is deliberately absent: it is what the browser reports when *we*
 * call `abort()` (on send, on close, on unmount), i.e. the success path, and
 * surfacing an error for a deliberate stop would be a lie.
 */
const ERROR_COPY: Record<string, string> = {
  "not-allowed":
    "Microphone access is blocked. Allow it for this site in your browser settings, then try again.",
  "service-not-allowed":
    "Your browser blocked its speech service. Allow microphone access for this site, then try again.",
  "no-speech": "Didn't catch anything — try again and speak after the dot turns on.",
  "audio-capture": "No microphone found. Check that one is connected and try again.",
  network: "Speech recognition needs a connection. Check yours and try again.",
};

const FALLBACK_ERROR_COPY = "Dictation stopped unexpectedly. Try again.";

/** How long "Dictation stopped." lingers in the live region after a stop. */
const STOPPED_ANNOUNCEMENT_MS = 2500;

function subscribeNever(): () => void {
  return () => {};
}

function getSupportedSnapshot(): boolean {
  return getRecognitionConstructor() !== null;
}

function getServerSnapshot(): boolean {
  return false;
}

export type UseDictationResult = {
  /** `false` on the server, on the first client render, and in Firefox. */
  supported: boolean;
  listening: boolean;
  /** The not-yet-final phrase, for a live preview. `""` when there is none. */
  interim: string;
  /** Human copy for the last error, or `null`. Cleared on the next start. */
  error: string | null;
  /** Text for an `aria-live="polite"` region. `""` when there is nothing to say. */
  status: string;
  /** Start if idle, stop if listening. Safe to call when unsupported (no-op). */
  toggle: () => void;
  /** Hard stop — used on send, on close, and on unmount. Idempotent. */
  stop: () => void;
};

export function useDictation({
  onFinalTranscript,
}: {
  /** Called once per settled phrase. The caller decides how to append it. */
  onFinalTranscript: (text: string) => void;
}): UseDictationResult {
  // `useSyncExternalStore` rather than a `useState` + effect pair: this is a
  // read of a browser capability that never changes for the life of the page,
  // and this hook is exactly React's supported way to read one *without*
  // risking a hydration mismatch — the server snapshot is a hard `false`, the
  // client snapshot is the real answer, and the subscribe function is a no-op
  // because nothing will ever invalidate it.
  const supported = useSyncExternalStore(
    subscribeNever,
    getSupportedSnapshot,
    getServerSnapshot
  );
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // The callback is read from a ref so that a caller passing a fresh closure
  // each render does not force the recognizer to be torn down and rebuilt —
  // rebuilding mid-utterance would drop the phrase in progress.
  // Assigned in an effect, not during render: the lint rule against writing
  // refs mid-render is right, and an effect is early enough — the callback is
  // only ever read from inside a recognizer event, long after commit.
  const onFinalRef = useRef(onFinalTranscript);
  useEffect(() => {
    onFinalRef.current = onFinalTranscript;
  }, [onFinalTranscript]);
  const stoppedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearStoppedTimeout = useCallback(() => {
    if (stoppedTimeoutRef.current !== null) {
      clearTimeout(stoppedTimeoutRef.current);
      stoppedTimeoutRef.current = null;
    }
  }, []);

  /**
   * Tear the recognizer down for good.
   *
   * `abort()` rather than `stop()`: `stop()` asks for one last result and keeps
   * the session alive until it arrives, which leaves the browser's tab-level
   * microphone indicator lit after the user has clearly finished. Handlers are
   * nulled first so the abort's own `onend`/`onerror` cannot write state back
   * into a component that is closing or already unmounted.
   */
  const teardown = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.onstart = null;
    recognitionRef.current = null;
    try {
      recognition.abort();
    } catch {
      // A recognizer that never successfully started throws on abort in some
      // builds. There is nothing to recover — it is already not listening.
    }
  }, []);

  const stop = useCallback(() => {
    const wasListening = recognitionRef.current !== null;
    teardown();
    setInterim("");
    setListening(false);
    if (wasListening) {
      setStatus("Dictation stopped.");
      clearStoppedTimeout();
      stoppedTimeoutRef.current = setTimeout(
        () => setStatus(""),
        STOPPED_ANNOUNCEMENT_MS
      );
    }
  }, [teardown, clearStoppedTimeout]);

  const start = useCallback(() => {
    const Ctor = getRecognitionConstructor();
    if (!Ctor) return;
    // Never run two sessions at once — a second `start()` on a live recognizer
    // throws `InvalidStateError` in Chrome.
    teardown();
    clearStoppedTimeout();
    setError(null);
    setInterim("");

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Ctor();
    } catch {
      setError(FALLBACK_ERROR_COPY);
      return;
    }

    recognition.lang = resolveLanguage();
    // Continuous so a pause between sentences does not end the session, and
    // interim so the preview line can move while the user is still talking.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setListening(true);
      setStatus("Listening…");
    };

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let finalText = "";
      let interimText = "";
      // From `resultIndex`, not 0: `results` is cumulative for the session, so
      // replaying it from the start would re-commit every phrase already sent
      // to the composer on each new chunk.
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }
      setInterim(interimText.trim());
      const settled = finalText.trim();
      if (settled) onFinalRef.current(settled);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
      if (event.error === "aborted") return; // our own stop(); not a failure
      setError(ERROR_COPY[event.error] ?? FALLBACK_ERROR_COPY);
      setInterim("");
      setListening(false);
      setStatus("");
      teardown();
    };

    recognition.onend = () => {
      // Reached when the service ends the session itself (long silence, or a
      // browser-imposed cap). Settle the UI rather than leaving a mic button
      // that claims to be listening to nothing.
      setInterim("");
      setListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      teardown();
      setListening(false);
      setError(FALLBACK_ERROR_COPY);
    }
  }, [teardown, clearStoppedTimeout]);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  // Unmount is the panel closing, in this app's portal pattern — a dangling
  // recognizer would keep the browser's microphone indicator lit on a page
  // with no visible chat on it, which reads as the site listening in secret.
  useEffect(() => {
    return () => {
      teardown();
      clearStoppedTimeout();
    };
  }, [teardown, clearStoppedTimeout]);

  return { supported, listening, interim, error, status, toggle, stop };
}

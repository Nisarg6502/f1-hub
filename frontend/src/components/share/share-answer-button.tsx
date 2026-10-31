"use client";

import { useCallback } from "react";
import type { AgentVisual } from "@/lib/agent-api";
import { shareFilename, type ShareFormat } from "@/lib/share";
import { ShareButton } from "./share-button";
import { renderAnswerCard } from "./answer-card";

/**
 * Share one Pitwall answer — the question, the answer text and its first
 * chart — as an image.
 *
 * Self-contained so the panel's insertion is one import and one JSX line:
 * `pitwall-assistant-panel.tsx` is shared with other in-flight work, and
 * everything about sharing should be deletable from it in one keystroke.
 *
 * No Copy link: an answer has no address. Chat history does not exist yet,
 * and a link that opened an empty assistant would be worse than none.
 *
 * The filename carries no words from the question. It is written to the
 * reader's disk and may be uploaded somewhere; "apex-pitwall-answer" says
 * what it is without repeating something they typed.
 */
export default function ShareAnswerButton({
  question,
  text,
  visuals,
}: {
  question: string | null;
  /** The answer with citation markers already stripped (`buildAnchoredMarkdown().plainText`). */
  text: string;
  visuals: readonly AgentVisual[];
}) {
  const render = useCallback(
    async (format: ShareFormat) => {
      const { blob, chart } = await renderAnswerCard({
        question: question ?? "",
        answerMarkdown: text,
        visuals,
        format,
      });
      return {
        blob,
        note:
          chart === "failed"
            ? "The chart couldn't be drawn into the image; the card says so."
            : chart === "drawn-svg"
              ? "This browser can only include the chart itself, not its legend."
              : undefined,
      };
    },
    [question, text, visuals]
  );
  const filenameFor = useCallback((format: ShareFormat) => shareFilename(["pitwall-answer"], format), []);

  if (!text.trim()) return null;
  return (
    <ShareButton
      size="sm"
      label="Share this answer as an image"
      surface="answer"
      heading="Share this answer"
      render={render}
      filenameFor={filenameFor}
    />
  );
}

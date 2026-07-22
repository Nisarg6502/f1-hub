"use client";

import { useMemo } from "react";

interface LocalDateTimeProps {
  timestampMs: number;
  options?: Intl.DateTimeFormatOptions;
}

export default function LocalDateTime({ timestampMs, options }: LocalDateTimeProps) {
  const text = useMemo(
    () =>
      new Date(timestampMs).toLocaleString(
        undefined,
        // When the caller passes options, treat them as authoritative so they
        // can drop the month/day and show, e.g., just "Fri 17:00".
        options ?? {
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }
      ),
    [timestampMs, options]
  );

  return <>{text}</>;
}

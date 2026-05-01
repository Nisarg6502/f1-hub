"use client";

import { useMemo } from "react";

interface LocalDateTimeProps {
  timestampMs: number;
  options?: Intl.DateTimeFormatOptions;
}

export default function LocalDateTime({ timestampMs, options }: LocalDateTimeProps) {
  const text = useMemo(
    () =>
      new Date(timestampMs).toLocaleString(undefined, {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        ...(options ?? {}),
      }),
    [timestampMs, options]
  );

  return <>{text}</>;
}

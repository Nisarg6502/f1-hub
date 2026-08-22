import type { SessionWeather } from "@/lib/api";

interface ConditionsTileProps {
  weather: SessionWeather | null | undefined;
  /**
   * The session these figures belong to, e.g. "Race", "FP2", "Sprint Race".
   *
   * Required rather than optional, and that is the point of this component's
   * current shape. `/race_weather` is race-only by construction, while this
   * tile is rendered inside `SessionTabs` alongside practice, qualifying and
   * the sprint. Under the old bare "Conditions" heading the race's numbers
   * read as belonging to whichever tab was open, and they never did.
   *
   * Measured against OpenF1 for Interlagos 2024: the sprint ran at 28.0°C air
   * / 48.0°C track and completely dry, while this tile showed 22.0 / 24.9 and
   * rain — a 23°C track error and a dry session presented as a wet one. Making
   * the caller name the session is what stops the tile from silently
   * mislabelling data again.
   */
  sessionLabel: string;
}

// Only the fields OpenF1 actually reported for this session are shown — same
// "render what we have" convention as the circuit info bar above it.
export default function ConditionsTile({ weather, sessionLabel }: ConditionsTileProps) {
  if (!weather) return null;

  const stats: Array<{ label: string; value: string | number }> = (
    [
      {
        label: "Air",
        value:
          weather.air_temperature != null ? `${weather.air_temperature.toFixed(1)}°C` : null,
      },
      {
        label: "Track",
        value:
          weather.track_temperature != null
            ? `${weather.track_temperature.toFixed(1)}°C`
            : null,
      },
      {
        label: "Wind",
        value:
          weather.wind_speed != null
            ? `${weather.wind_speed.toFixed(1)} m/s${
                weather.wind_direction != null ? ` · ${Math.round(weather.wind_direction)}°` : ""
              }`
            : null,
      },
      {
        // Derived from every sample in the session, not the one instant the
        // temperatures come from — a midpoint read reports any session whose
        // rain fell outside that minute as bone dry. The share is shown
        // alongside "Yes" because "Yes" alone cannot separate a 21%-wet sprint
        // from a single stray sample. Rounds cached before schema 2 have no
        // share and fall back to a bare "Yes".
        label: "Rain",
        value:
          weather.rainfall == null
            ? null
            : weather.rainfall === 0
              ? "No"
              : weather.rainfall_share != null
                ? `Yes · ${Math.round(weather.rainfall_share * 100)}% of session`
                : "Yes",
      },
      {
        label: "Humidity",
        value: weather.humidity != null ? `${Math.round(weather.humidity)}%` : null,
      },
      {
        label: "Pressure",
        value: weather.pressure != null ? `${weather.pressure.toFixed(1)} hPa` : null,
      },
    ] as Array<{ label: string; value: string | number | null }>
  ).flatMap((stat) => (stat.value === null ? [] : [{ ...stat, value: stat.value }]));

  if (stats.length === 0) return null;

  return (
    <div className="mb-6">
      <p className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500 mb-2.5">
        {sessionLabel} conditions
      </p>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3.5">
        {stats.map((stat) => (
          <div key={stat.label} className="apex-glass-soft rounded-tile px-[22px] py-[18px]">
            <p className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500">
              {stat.label}
            </p>
            <p className="font-[family-name:var(--font-headline)] font-bold text-lg mt-1 tabular-nums">
              {stat.value}
            </p>
          </div>
        ))}
      </div>
      <p className="font-medium text-[11px] text-warm-500 mt-2.5">
        Temperatures, wind, humidity and pressure are a single mid-session sample from OpenF1,
        not an average.
      </p>
    </div>
  );
}

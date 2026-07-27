interface Weather {
  air_temperature?: number | null;
  track_temperature?: number | null;
  wind_speed?: number | null;
  wind_direction?: number | null;
  rainfall?: number | null;
  humidity?: number | null;
  pressure?: number | null;
}

interface ConditionsTileProps {
  weather: Weather | null | undefined;
}

// Only the fields FastF1/OpenF1 actually reported for this event are shown —
// same "render what we have" convention as the circuit info bar above it.
export default function ConditionsTile({ weather }: ConditionsTileProps) {
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
        label: "Rain",
        value: weather.rainfall != null ? (weather.rainfall > 0 ? "Yes" : "No") : null,
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
        Conditions
      </p>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3.5">
        {stats.map((stat) => (
          <div key={stat.label} className="apex-glass-soft rounded-[14px] px-[22px] py-[18px]">
            <p className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500">
              {stat.label}
            </p>
            <p className="font-[family-name:var(--font-headline)] font-bold text-lg mt-1 tabular-nums">
              {stat.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

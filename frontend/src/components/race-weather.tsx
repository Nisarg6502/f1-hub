import { Suspense } from "react";
import { getRaceWeather } from "@/lib/api";
import { getSessionKeyByDate, getWeather } from "@/lib/openf1";

interface WeatherData {
  air_temperature?: number;
  track_temperature?: number;
  wind_speed?: number;
  rainfall?: number;
}

async function WeatherContent({ year, round, dateStr }: { year: number; round: number; dateStr: string }) {
  let weather: WeatherData | null = null;

  // 1. Try backend API first (cached in MongoDB)
  try {
    const res = await getRaceWeather(year, round);
    if (res.weather && res.weather.air_temperature != null) {
      weather = res.weather;
    }
  } catch {
    // fall through to OpenF1
  }

  // 2. Fallback to direct OpenF1 API
  if (!weather) {
    try {
      const sessionKey = await getSessionKeyByDate(year, dateStr, "Race");
      if (sessionKey) {
        const openF1Weather = await getWeather(sessionKey);
        if (openF1Weather) {
          weather = openF1Weather;
        }
      }
    } catch {
      // no weather data available
    }
  }

  if (!weather) return <WeatherFallback />;

  return (
    <div className="flex items-center gap-4 border-l border-neutral-800 pl-4 py-1 ml-4">
      <div className="flex flex-col">
        <span className="text-[10px] text-neutral-500 uppercase tracking-widest font-bold flex items-center gap-1">
          <span className="material-symbols-outlined text-[12px]">thermostat</span>
          Air
        </span>
        <span className="font-[family-name:var(--font-headline)] font-bold text-lg italic text-neutral-300">
          {weather.air_temperature}°C
        </span>
      </div>
      <div className="flex flex-col">
        <span className="text-[10px] text-neutral-500 uppercase tracking-widest font-bold flex items-center gap-1">
          <span className="material-symbols-outlined text-[12px]">road</span>
          Track
        </span>
        <span className="font-[family-name:var(--font-headline)] font-bold text-lg italic text-neutral-300">
          {weather.track_temperature}°C
        </span>
      </div>
      <div className="flex flex-col">
        <span className="text-[10px] text-neutral-500 uppercase tracking-widest font-bold flex items-center gap-1">
          <span className="material-symbols-outlined text-[12px]">air</span>
          Wind
        </span>
        <span className="font-[family-name:var(--font-headline)] font-bold text-lg italic text-neutral-300">
          {weather.wind_speed} m/s
        </span>
      </div>
      {(weather.rainfall ?? 0) > 0 && (
        <div className="flex flex-col">
          <span className="text-[10px] text-blue-400 uppercase tracking-widest font-bold flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px]">rainy</span>
            Rain
          </span>
          <span className="font-[family-name:var(--font-headline)] font-bold text-lg italic text-blue-400">
            Yes
          </span>
        </div>
      )}
    </div>
  );
}

function WeatherFallback() {
  return null;
}

export default function RaceWeather({ year, round, dateStr }: { year: number; round: number; dateStr: string }) {
  if (year < 2023) return null; // OpenF1 mostly has 2023+ data

  return (
    <Suspense fallback={<WeatherFallback />}>
      <WeatherContent year={year} round={round} dateStr={dateStr} />
    </Suspense>
  );
}

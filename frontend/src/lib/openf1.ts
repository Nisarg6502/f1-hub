const OPENF1_BASE = "https://api.openf1.org/v1";
const OPENF1_TOKEN = process.env.OPENF1_TOKEN;

export async function fetchOpenF1<T>(endpoint: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`${OPENF1_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  
  const headers: Record<string, string> = {};
  if (OPENF1_TOKEN) {
    headers["Authorization"] = `Bearer ${OPENF1_TOKEN}`;
  }

  try {
    const res = await fetch(url.toString(), { 
      cache: "no-store",
      headers
    });
    
    if (res.status === 401) {
      console.warn(`OpenF1 Unauthorized (401): ${url.toString()}. This data likely requires a paid subscription for the current season.`);
      return [] as unknown as T;
    }
    
    if (!res.ok) {
      console.error(`OpenF1 error ${res.status} for ${url.toString()}`);
      return [] as unknown as T;
    }
    
    return (await res.json()) as T;
  } catch (err) {
    console.error(`OpenF1 fetch error for ${url.toString()}:`, err);
    return [] as unknown as T;
  }
}

export async function getSessionKeyByDate(year: number, dateStr: string, sessionType: string = "Race"): Promise<number | null> {
  const sessions = await fetchOpenF1<any[]>("/sessions", { year, session_type: sessionType });
  // Match by date (ignoring time)
  const session = sessions.find(s => s.date_start?.startsWith(dateStr));
  return session?.session_key ?? null;
}

export async function getStints(sessionKey: number, driverNumbers: number[]) {
  const stints = await fetchOpenF1<any[]>("/stints", { session_key: sessionKey });
  return stints.filter(s => driverNumbers.includes(s.driver_number));
}

export async function getLaps(sessionKey: number, driverNumbers: number[]) {
  const laps = await fetchOpenF1<any[]>("/laps", { session_key: sessionKey });
  return laps.filter(l => driverNumbers.includes(l.driver_number));
}

export async function getRaceControl(sessionKey: number) {
  return fetchOpenF1<any[]>("/race_control", { session_key: sessionKey });
}

export async function getWeather(sessionKey: number) {
  const weatherList = await fetchOpenF1<any[]>("/weather", { session_key: sessionKey });
  if (!weatherList || weatherList.length === 0) return null;
  // Return the middle of the session to get a representative weather
  const midIdx = Math.floor(weatherList.length / 2);
  return weatherList[midIdx];
}

const OPENF1_BASE = "https://api.openf1.org/v1";

export async function fetchOpenF1<T>(endpoint: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`${OPENF1_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`OpenF1 error ${res.status}`);
  return (await res.json()) as T;
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

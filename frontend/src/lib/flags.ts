/**
 * Maps nationality strings (as returned by the Ergast API) to flag image
 * filenames in /public/flags/.
 */
const NATIONALITY_TO_FLAG: Record<string, string> = {
  Dutch: "Netherlands",
  British: "Great_Britain",
  Monegasque: "Monaco",
  Spanish: "Spain",
  Australian: "Australia",
  Canadian: "Canada",
  German: "Germany",
  Mexican: "Mexico",
  Finnish: "Finland",
  French: "France",
  Thai: "Thailand",
  Japanese: "Japan",
  Italian: "Italy",
  American: "United_States",
  Brazilian: "Brazil",
  "New Zealander": "New_Zealand",
  Argentine: "Argentina",
  Argentinian: "Argentina",
  Austrian: "Austria",
};

/**
 * Maps country names (from Circuit.Location.country) to flag filenames.
 */
const COUNTRY_TO_FLAG: Record<string, string> = {
  Australia: "Australia",
  Austria: "Austria",
  Argentina: "Argentina",
  Brazil: "Brazil",
  Canada: "Canada",
  Finland: "Finland",
  France: "France",
  Germany: "Germany",
  Italy: "Italy",
  Japan: "Japan",
  Mexico: "Mexico",
  Monaco: "Monaco",
  Netherlands: "Netherlands",
  "New Zealand": "New_Zealand",
  Spain: "Spain",
  Thailand: "Thailand",
  UK: "Great_Britain",
  USA: "United_States",
  "United States": "United_States",
  "United Kingdom": "Great_Britain",
  "Great Britain": "Great_Britain",
};

/**
 * Returns the URL path to the flag PNG for a given nationality string.
 * Returns null if no matching flag is found.
 */
export function getFlagPath(nationality?: string | null): string | null {
  if (!nationality) return null;
  const key = NATIONALITY_TO_FLAG[nationality];
  return key ? `/flags/${key}.png` : null;
}

/**
 * Returns the URL path to the flag PNG for a given country name.
 * Returns null if no matching flag is found.
 */
export function getCountryFlagPath(country?: string | null): string | null {
  if (!country) return null;
  const key = COUNTRY_TO_FLAG[country];
  return key ? `/flags/${key}.png` : null;
}

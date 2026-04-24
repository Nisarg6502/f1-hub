/**
 * Strips diacritics / accents from a string.
 * e.g. "Hülkenberg" → "Hulkenberg", "Pérez" → "Perez"
 */
function stripDiacritics(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Explicit overrides for drivers whose API name doesn't match the filename.
 * Key = normalised "GivenName_FamilyName" from the API (after diacritics are
 * stripped).  Value = the exact filename stem in /public/drivers/.
 */
const NAME_OVERRIDES: Record<string, string> = {
  "Andrea_Kimi_Antonelli": "Kimi_Antonelli",
  // Add more overrides here if needed in the future
};

/**
 * All available driver images for fast existence checks.
 */
const AVAILABLE_DRIVERS = new Set([
  "Alexander_Albon",
  "Arvid_Lindblad",
  "Carlos_Sainz",
  "Charles_Leclerc",
  "Esteban_Ocon",
  "Fernando_Alonso",
  "Franco_Colapinto",
  "Gabriel_Bortoleto",
  "George_Russell",
  "Isack_Hadjar",
  "Kimi_Antonelli",
  "Lance_Stroll",
  "Lando_Norris",
  "Lewis_Hamilton",
  "Liam_Lawson",
  "Max_Verstappen",
  "Nico_Hulkenberg",
  "Oliver_Bearman",
  "Oscar_Piastri",
  "Pierre_Gasly",
  "Sergio_Perez",
  "Valtteri_Bottas",
]);

/**
 * Resolves the filename stem for a driver, handling diacritics and overrides.
 */
function resolveDriverKey(
  givenName?: string | null,
  familyName?: string | null
): string | null {
  if (!givenName || !familyName) return null;

  const normFirst = stripDiacritics(givenName.trim()).replace(/\s+/g, "_");
  const normLast = stripDiacritics(familyName.trim()).replace(/\s+/g, "_");
  const raw = `${normFirst}_${normLast}`;

  // Check explicit overrides first
  if (NAME_OVERRIDES[raw]) return NAME_OVERRIDES[raw];

  // Direct match
  if (AVAILABLE_DRIVERS.has(raw)) return raw;

  // Try matching on familyName only (handles multi-word given names)
  for (const key of AVAILABLE_DRIVERS) {
    if (key.endsWith(`_${normLast}`)) return key;
  }

  return null;
}

/**
 * Builds the URL path to a driver's transparent PNG image.
 * Returns null if no image is available.
 */
export function getDriverImagePath(
  givenName?: string | null,
  familyName?: string | null
): string | null {
  const key = resolveDriverKey(givenName, familyName);
  return key ? `/drivers/${key}.png` : null;
}

/**
 * Returns true when a matching driver image exists.
 */
export function hasDriverImage(
  givenName?: string | null,
  familyName?: string | null
): boolean {
  return resolveDriverKey(givenName, familyName) !== null;
}

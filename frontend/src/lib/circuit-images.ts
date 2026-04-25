const ASSET_BASE = process.env.NEXT_PUBLIC_ASSET_BASE_URL ?? "";

export function getCircuitImagePath(country?: string, locality?: string, circuitName?: string): string | null {
  if (!country) return null;
  
  const c = country.toLowerCase();
  const l = (locality || "").toLowerCase();
  const cn = (circuitName || "").toLowerCase();

  // Specific localities first
  if (l.includes("las vegas")) return `${ASSET_BASE}/circuits/Las_Vegas_Circuit.avif`;
  if (l.includes("miami")) return `${ASSET_BASE}/circuits/Miami_Circuit.avif`;
  if (l.includes("austin") || cn.includes("americas")) return `${ASSET_BASE}/circuits/USA_Circuit.avif`;
  if (l.includes("baku") || c === "azerbaijan") return `${ASSET_BASE}/circuits/Baku_Circuit.avif`;
  if (l.includes("madrid")) return `${ASSET_BASE}/circuits/Madrid_Circuit.avif`;
  if (l.includes("abu dhabi") || c === "uae") return `${ASSET_BASE}/circuits/Abu_Dhabi_Circuit.avif`;
  if (c === "uk" || c === "great britain") return `${ASSET_BASE}/circuits/Great_Britain_Circuit.avif`;
  
  // Country fallback
  const map: Record<string, string> = {
    "australia": "Australia_Circuit.avif",
    "austria": "Austria_Circuit.avif",
    "belgium": "Belgium_Circuit.avif",
    "brazil": "Brazil_Circuit.avif",
    "canada": "Canada_Circuit.avif",
    "china": "China_Circuit.avif",
    "hungary": "Hungary_Circuit.avif",
    "italy": "Italy_Circuit.avif",
    "japan": "Japan_Circuit.avif",
    "mexico": "Mexico_Circuit.avif",
    "monaco": "Monaco_Circuit.avif",
    "netherlands": "Netherlands_Circuit.avif",
    "qatar": "Qatar_Circuit.avif",
    "singapore": "Singapore_Circuit.avif",
    "spain": "Spain_Circuit.avif",
    "usa": "USA_Circuit.avif",
  };

  const file = map[c];
  if (file) return `${ASSET_BASE}/circuits/${file}`;

  return null;
}

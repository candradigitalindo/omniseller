/**
 * Indonesian provinces and the island groups they belong to (backend doc 8.21): how far a warehouse is
 * from a buyer when an order is allocated automatically (PRD FR-ORD-12). Addresses arrive written in
 * many ways ("DKI JAKARTA", "Jakarta", "NANGGROE ACEH DARUSSALAM (NAD)", "Jatim"), so names are
 * compared after normalizing and through aliases.
 */

export type Island = "sumatera" | "jawa" | "bali_nusa_tenggara" | "kalimantan" | "sulawesi" | "maluku" | "papua";

interface Province {
  /** Canonical name, as Kemendagri writes it. */
  name: string;
  island: Island;
  aliases: string[];
}

/** The 38 provinces (2022 onwards). */
const PROVINCES: readonly Province[] = [
  { name: "Aceh", island: "sumatera", aliases: ["Nanggroe Aceh Darussalam", "NAD", "Daerah Istimewa Aceh"] },
  { name: "Sumatera Utara", island: "sumatera", aliases: ["Sumut", "Sumatra Utara", "North Sumatra"] },
  { name: "Sumatera Barat", island: "sumatera", aliases: ["Sumbar", "Sumatra Barat", "West Sumatra"] },
  { name: "Riau", island: "sumatera", aliases: [] },
  { name: "Kepulauan Riau", island: "sumatera", aliases: ["Kepri", "Riau Islands"] },
  { name: "Jambi", island: "sumatera", aliases: [] },
  { name: "Bengkulu", island: "sumatera", aliases: [] },
  { name: "Sumatera Selatan", island: "sumatera", aliases: ["Sumsel", "Sumatra Selatan", "South Sumatra"] },
  {
    name: "Kepulauan Bangka Belitung",
    island: "sumatera",
    aliases: ["Bangka Belitung", "Babel", "Kep. Bangka Belitung"],
  },
  { name: "Lampung", island: "sumatera", aliases: [] },
  {
    name: "DKI Jakarta",
    island: "jawa",
    aliases: ["Jakarta", "Daerah Khusus Ibukota Jakarta", "Daerah Khusus Jakarta", "DKJ"],
  },
  { name: "Jawa Barat", island: "jawa", aliases: ["Jabar", "West Java"] },
  { name: "Banten", island: "jawa", aliases: [] },
  { name: "Jawa Tengah", island: "jawa", aliases: ["Jateng", "Central Java"] },
  {
    name: "DI Yogyakarta",
    island: "jawa",
    aliases: ["Yogyakarta", "Daerah Istimewa Yogyakarta", "DIY", "Jogja", "Jogjakarta"],
  },
  { name: "Jawa Timur", island: "jawa", aliases: ["Jatim", "East Java"] },
  { name: "Bali", island: "bali_nusa_tenggara", aliases: [] },
  { name: "Nusa Tenggara Barat", island: "bali_nusa_tenggara", aliases: ["NTB", "West Nusa Tenggara"] },
  { name: "Nusa Tenggara Timur", island: "bali_nusa_tenggara", aliases: ["NTT", "East Nusa Tenggara"] },
  { name: "Kalimantan Barat", island: "kalimantan", aliases: ["Kalbar", "West Kalimantan"] },
  { name: "Kalimantan Tengah", island: "kalimantan", aliases: ["Kalteng", "Central Kalimantan"] },
  { name: "Kalimantan Selatan", island: "kalimantan", aliases: ["Kalsel", "South Kalimantan"] },
  { name: "Kalimantan Timur", island: "kalimantan", aliases: ["Kaltim", "East Kalimantan"] },
  { name: "Kalimantan Utara", island: "kalimantan", aliases: ["Kaltara", "North Kalimantan"] },
  { name: "Sulawesi Utara", island: "sulawesi", aliases: ["Sulut", "North Sulawesi"] },
  { name: "Gorontalo", island: "sulawesi", aliases: [] },
  { name: "Sulawesi Tengah", island: "sulawesi", aliases: ["Sulteng", "Central Sulawesi"] },
  { name: "Sulawesi Barat", island: "sulawesi", aliases: ["Sulbar", "West Sulawesi"] },
  { name: "Sulawesi Selatan", island: "sulawesi", aliases: ["Sulsel", "South Sulawesi"] },
  { name: "Sulawesi Tenggara", island: "sulawesi", aliases: ["Sultra", "Southeast Sulawesi"] },
  { name: "Maluku", island: "maluku", aliases: [] },
  { name: "Maluku Utara", island: "maluku", aliases: ["Malut", "North Maluku"] },
  { name: "Papua", island: "papua", aliases: [] },
  { name: "Papua Barat", island: "papua", aliases: ["Pabar", "West Papua", "Irian Jaya Barat"] },
  { name: "Papua Barat Daya", island: "papua", aliases: ["Southwest Papua"] },
  { name: "Papua Tengah", island: "papua", aliases: ["Central Papua"] },
  { name: "Papua Pegunungan", island: "papua", aliases: ["Highland Papua"] },
  { name: "Papua Selatan", island: "papua", aliases: ["South Papua"] },
];

/** Letters only, lower case, without a leading "provinsi". */
function squash(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*(provinsi|prov\.?|propinsi)\s+/, "")
    .replace(/[^a-z]/g, "");
}

const BY_KEY = new Map<string, Province>();
for (const p of PROVINCES) {
  for (const name of [p.name, ...p.aliases]) BY_KEY.set(squash(name), p);
}

/** The province an address names, or null when it names none OmniSeller knows. */
export function provinceOf(text: string | null | undefined): { name: string; island: Island } | null {
  if (!text?.trim()) return null;
  const found = BY_KEY.get(squash(text)) ?? BY_KEY.get(squash(text.replace(/\(.*?\)/g, " ")));
  return found ? { name: found.name, island: found.island } : null;
}

/** How near a warehouse is to a buyer: 2 same province, 1 same island group, 0 farther or unknown. */
export function nearness(buyerProvince: string | null | undefined, warehouseProvince: string | null | undefined) {
  const a = provinceOf(buyerProvince);
  const b = provinceOf(warehouseProvince);
  if (!a || !b) return 0;
  if (a.name === b.name) return 2;
  return a.island === b.island ? 1 : 0;
}

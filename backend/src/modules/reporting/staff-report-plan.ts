import type { CsvValue } from "../../common/csv";
import type { StaffActionRow } from "../orders/orders.repository";

/**
 * The team performance report (PRD FR-RPT-10, UI L33, backend doc 8.35) as pure functions: the figures of
 * the groups the orders module counted from the order history, team members ranked, and the CSV rows.
 */

export interface StaffFigures {
  /** Orders the user moved on (accepted, shipment arranged, packed, shipped, handed over), each once. */
  processed: number;
  packed: number;
  /** Of `packed`, checked item by item at the packing station (FR-SHP-04). */
  packedByScan: number;
  labels: number;
  /** Orders in the pick lists the user printed. */
  pickLists: number;
  /** Orders whose packing list the user printed, alone or with the label. */
  packingLists: number;
  /** Parcels in the courier handovers the user completed (FR-SHP-05). */
  handedOver: number;
  /** Packs by scan timed under the limit, and their average in seconds (null without any). */
  timedPacks: number;
  packSecondsAverage: number | null;
}

export interface StaffMember extends StaffFigures {
  userId: string;
  /** Null when the user is no longer in the business. */
  name: string | null;
}

export interface StaffDay extends StaffFigures {
  date: string;
}

export interface StaffMemberDay extends StaffFigures {
  userId: string;
  date: string;
}

export interface StaffReport {
  total: StaffFigures;
  users: StaffMember[];
  /** The whole team per day: an order two members processed counts once. */
  days: StaffDay[];
  userDays: StaffMemberDay[];
}

export const NO_FIGURES: StaffFigures = {
  processed: 0,
  packed: 0,
  packedByScan: 0,
  labels: 0,
  pickLists: 0,
  packingLists: 0,
  handedOver: 0,
  timedPacks: 0,
  packSecondsAverage: null,
};

export function figuresOf(r: StaffActionRow): StaffFigures {
  return {
    processed: r.processed,
    packed: r.packed,
    packedByScan: r.packedByScan,
    labels: r.labels,
    pickLists: r.pickLists,
    packingLists: r.packingLists,
    handedOver: r.handedOver,
    timedPacks: r.timedPacks,
    packSecondsAverage: r.timedPacks > 0 ? Math.round(r.packSeconds / r.timedPacks) : null,
  };
}

/**
 * The counted groups apart: the team in all, each member, each day, each member's days. Members with the
 * most orders processed come first, then the most packed, then by name; days run in date order, a day's
 * members in that same order.
 */
export function staffReport(rows: readonly StaffActionRow[], names: ReadonlyMap<string, string>): StaffReport {
  let total = NO_FIGURES;
  const users: StaffMember[] = [];
  const days: StaffDay[] = [];
  const userDays: StaffMemberDay[] = [];
  for (const r of rows) {
    const f = figuresOf(r);
    if (r.userId && r.day) userDays.push({ userId: r.userId, date: r.day, ...f });
    else if (r.userId) users.push({ userId: r.userId, name: names.get(r.userId) ?? null, ...f });
    else if (r.day) days.push({ date: r.day, ...f });
    else total = f;
  }
  users.sort(
    (a, b) =>
      b.processed - a.processed ||
      b.packed - a.packed ||
      (a.name ?? "").localeCompare(b.name ?? "", "id") ||
      a.userId.localeCompare(b.userId),
  );
  const rank = new Map(users.map((u, i) => [u.userId, i]));
  days.sort((a, b) => a.date.localeCompare(b.date));
  userDays.sort((a, b) => a.date.localeCompare(b.date) || (rank.get(a.userId) ?? 0) - (rank.get(b.userId) ?? 0));
  return { total, users, days, userDays };
}

export type StaffSection = "users" | "days";

/** A member no longer in the business, in the CSV. */
export const UNKNOWN_MEMBER = "Pengguna tidak dikenal";

const FIGURE_HEADERS = [
  "pesanan_diproses",
  "dikemas",
  "dikemas_dengan_scan",
  "label_dicetak",
  "pesanan_di_pick_list",
  "daftar_kemas_dicetak",
  "diserahkan_ke_kurir",
  "kemas_berwaktu",
  "rata_rata_detik_kemas",
];

const cells = (f: StaffFigures): CsvValue[] => [
  f.processed,
  f.packed,
  f.packedByScan,
  f.labels,
  f.pickLists,
  f.packingLists,
  f.handedOver,
  f.timedPacks,
  f.packSecondsAverage,
];

/** UI L33 "Unduh": per member for the period, or per member per day. */
export function staffCsvRows(r: StaffReport, section: StaffSection): CsvValue[][] {
  const nameOf = new Map(r.users.map((u) => [u.userId, u.name ?? UNKNOWN_MEMBER]));
  if (section === "users")
    return [["nama", ...FIGURE_HEADERS], ...r.users.map((u) => [nameOf.get(u.userId), ...cells(u)])];
  return [
    ["tanggal", "nama", ...FIGURE_HEADERS],
    ...r.userDays.map((d) => [d.date, nameOf.get(d.userId) ?? UNKNOWN_MEMBER, ...cells(d)]),
  ];
}

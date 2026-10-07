import { describe, expect, it } from "vitest";
import type { WeekSchedule } from "../../db/schema";
import {
  addDays,
  type CourierCalendarInput,
  cutoffFor,
  hoursOn,
  internalDeadline,
  internalSlaOf,
  minutesOf,
  sameCourier,
  weekdayOf,
  weekProblem,
} from "./cutoff-plan";

const WH = "01WAREHOUSEJKT000000000000";
const MON_SAT = [1, 2, 3, 4, 5, 6];
const open = (o: string, c: string) => ({ open: o, close: c });
/** Mon to Fri 08:00 to 17:00, Saturday until 14:00, Sunday closed. */
const WEEK: WeekSchedule = [
  null,
  open("08:00", "17:00"),
  open("08:00", "17:00"),
  open("08:00", "17:00"),
  open("08:00", "17:00"),
  open("08:00", "17:00"),
  open("08:00", "14:00"),
];
const cal = (over: Partial<CourierCalendarInput> = {}): CourierCalendarInput => ({
  timezone: "Asia/Jakarta",
  cutoffs: [{ warehouseId: WH, courier: "J&T Express", time: "15:00:00", days: MON_SAT }],
  holidays: [],
  week: null,
  periods: [],
  ...over,
});
/** A local time in Jakarta (UTC+7) as an instant. */
const wib = (local: string) => new Date(`${local}+07:00`);
const deadline = (input: CourierCalendarInput, readyAt: Date, courier: string | null = "J&T Express") =>
  internalDeadline(input, { warehouseId: WH, courier, readyAt })?.at.toISOString() ?? null;

describe("calendar arithmetic", () => {
  it("reads times and walks dates", () => {
    expect(minutesOf("15:00")).toBe(900);
    expect(minutesOf("07:30:00")).toBe(450);
    expect(minutesOf("24:00")).toBeNull();
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekdayOf("2026-10-05")).toBe(1);
    expect(weekdayOf("2026-10-11")).toBe(0);
  });
});

describe("which cut-off applies", () => {
  it("matches courier names as handovers do", () => {
    expect(sameCourier("J&T", "J&T Express")).toBe(true);
    expect(sameCourier("j&t express", "J&T EXPRESS")).toBe(true);
    expect(sameCourier("J&T Cargo", "J&T Express")).toBe(false);
    expect(sameCourier("", "JNE")).toBe(false);
  });

  it("takes the most specific name, and none for an order without a courier", () => {
    const cutoffs = [{ courier: "JNE" }, { courier: "JNE YES" }, { courier: "SPX" }];
    expect(cutoffFor(cutoffs, "JNE YES")?.courier).toBe("JNE YES");
    expect(cutoffFor(cutoffs, "JNE Reguler")?.courier).toBe("JNE");
    expect(cutoffFor(cutoffs, "SPX Hemat")?.courier).toBe("SPX");
    expect(cutoffFor(cutoffs, "SiCepat")).toBeNull();
    expect(cutoffFor(cutoffs, null)).toBeNull();
  });
});

describe("the internal deadline of an order", () => {
  it("is today's cut-off for an order that came before it, and the next day's after it", () => {
    expect(deadline(cal(), wib("2026-10-05T10:00:00"))).toBe("2026-10-05T08:00:00.000Z");
    // exactly at the cut-off it still counts for today
    expect(deadline(cal(), wib("2026-10-05T15:00:00"))).toBe("2026-10-05T08:00:00.000Z");
    expect(deadline(cal(), wib("2026-10-05T15:01:00"))).toBe("2026-10-06T08:00:00.000Z");
  });

  it("skips the days the courier does not come, and its holidays", () => {
    // Saturday afternoon: Sunday is not a pickup day
    expect(deadline(cal(), wib("2026-10-10T16:00:00"))).toBe("2026-10-12T08:00:00.000Z");
    const holidays = [{ date: "2026-10-06", courier: null }];
    expect(deadline(cal({ holidays }), wib("2026-10-05T16:00:00"))).toBe("2026-10-07T08:00:00.000Z");
    // a holiday of another courier changes nothing; one of this courier, by any spelling, does
    expect(deadline(cal({ holidays: [{ date: "2026-10-06", courier: "JNE" }] }), wib("2026-10-05T16:00:00"))).toBe(
      "2026-10-06T08:00:00.000Z",
    );
    expect(deadline(cal({ holidays: [{ date: "2026-10-06", courier: "j&t" }] }), wib("2026-10-05T16:00:00"))).toBe(
      "2026-10-07T08:00:00.000Z",
    );
  });

  it("ends when the business closes, if it closes before the cut-off, and skips closed days", () => {
    // Saturday closes at 14:00, before the 15:00 pickup
    expect(deadline(cal({ week: WEEK }), wib("2026-10-10T09:00:00"))).toBe("2026-10-10T07:00:00.000Z");
    // after 14:00 on Saturday, Sunday is closed: Monday at 15:00
    expect(deadline(cal({ week: WEEK }), wib("2026-10-10T14:30:00"))).toBe("2026-10-12T08:00:00.000Z");
  });

  it("follows a special period instead of the usual week on its dates", () => {
    const ramadan = WEEK.map((d) => (d ? open("08:00", "13:00") : null));
    const periods = [{ from: "2027-02-08", to: "2027-03-08", schedule: ramadan }];
    expect(deadline(cal({ week: WEEK, periods }), wib("2027-02-08T09:00:00"))).toBe("2027-02-08T06:00:00.000Z");
    // the day after the period, the usual week again
    expect(deadline(cal({ week: WEEK, periods }), wib("2027-03-09T09:00:00"))).toBe("2027-03-09T08:00:00.000Z");
    // a period with every day closed (Lebaran): the first pickup after it
    const lebaran = [{ from: "2027-03-08", to: "2027-03-12", schedule: [null, null, null, null, null, null, null] }];
    expect(deadline(cal({ week: WEEK, periods: lebaran }), wib("2027-03-08T09:00:00"))).toBe(
      "2027-03-13T07:00:00.000Z",
    );
  });

  it("is in the business's own time zone", () => {
    const wita = cal({ timezone: "Asia/Makassar" });
    expect(
      internalDeadline(wita, { warehouseId: WH, courier: "J&T Express", readyAt: new Date("2026-10-05T01:00:00Z") })
        ?.at,
    ).toEqual(new Date("2026-10-05T07:00:00Z"));
    const wit = cal({ timezone: "Asia/Jayapura" });
    expect(
      internalDeadline(wit, { warehouseId: WH, courier: "J&T Express", readyAt: new Date("2026-10-05T01:00:00Z") })?.at,
    ).toEqual(new Date("2026-10-05T06:00:00Z"));
  });

  it("has none without a warehouse, a matching courier, or a pickup in the next month", () => {
    expect(
      internalDeadline(cal(), { warehouseId: null, courier: "J&T Express", readyAt: wib("2026-10-05T10:00:00") }),
    ).toBeNull();
    expect(deadline(cal(), wib("2026-10-05T10:00:00"), "SiCepat")).toBeNull();
    expect(deadline(cal(), wib("2026-10-05T10:00:00"), null)).toBeNull();
    // another warehouse's cut-off does not apply
    const other = cal({ cutoffs: [{ warehouseId: "01OTHER", courier: "J&T Express", time: "15:00", days: MON_SAT }] });
    expect(deadline(other, wib("2026-10-05T10:00:00"))).toBeNull();
    const holidays = Array.from({ length: 40 }, (_, i) => ({ date: addDays("2026-10-05", i), courier: null }));
    expect(deadline(cal({ holidays }), wib("2026-10-05T10:00:00"))).toBeNull();
  });

  it("names the courier whose cut-off it is", () => {
    expect(
      internalDeadline(cal(), { warehouseId: WH, courier: "J&T EXPRESS", readyAt: wib("2026-10-05T10:00:00") })
        ?.courier,
    ).toBe("J&T Express");
  });
});

describe("operating hours", () => {
  it("checks a week before it is saved", () => {
    expect(weekProblem(WEEK)).toBeNull();
    expect(weekProblem(WEEK.slice(0, 6))).toBe("week");
    expect(weekProblem([...WEEK.slice(0, 6), open("14:00", "08:00")])).toBe("closeBeforeOpen");
    expect(weekProblem([...WEEK.slice(0, 6), open("8 pagi", "17:00")])).toBe("time");
  });

  it("knows the hours of a date, or that none are set", () => {
    expect(hoursOn({ week: null, periods: [] }, "2026-10-05")).toBeUndefined();
    expect(hoursOn({ week: WEEK, periods: [] }, "2026-10-11")).toBeNull();
    expect(hoursOn({ week: WEEK, periods: [] }, "2026-10-10")).toEqual(open("08:00", "14:00"));
    const periods = [{ from: "2026-10-10", to: "2026-10-10", schedule: WEEK.map(() => open("10:00", "12:00")) }];
    expect(hoursOn({ week: WEEK, periods }, "2026-10-10")).toEqual(open("10:00", "12:00"));
  });
});

describe("internal SLA", () => {
  const now = new Date("2026-10-05T05:00:00Z");
  it("is yellow under two hours to the cut-off, and missed once it passed", () => {
    expect(internalSlaOf(new Date("2026-10-05T08:00:00Z"), true, now)).toEqual({
      state: "ok",
      remainingMs: 3 * 3600_000,
    });
    expect(internalSlaOf(new Date("2026-10-05T07:00:00Z"), true, now)?.state).toBe("warning");
    expect(internalSlaOf(new Date("2026-10-05T05:00:00Z"), true, now)?.state).toBe("missed");
    expect(internalSlaOf(new Date("2026-10-05T08:00:00Z"), false, now)).toBeNull();
    expect(internalSlaOf(null, true, now)).toBeNull();
  });
});

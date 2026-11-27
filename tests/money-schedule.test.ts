import { describe, expect, it } from "vitest";
import { formatCedis, parseCedis } from "@/lib/money";
import { parseIsoDate, roundDueDates } from "@/lib/schedule";

describe("money", () => {
  it("parses cedis into whole pesewas without floats", () => {
    expect(parseCedis("100")).toBe(10000);
    expect(parseCedis("50.5")).toBe(5050);
    expect(parseCedis("0.10")).toBe(10);
    expect(parseCedis(" 1,200.00 ")).toBe(120000);
    expect(parseCedis("GH₵ 20")).toBe(2000);
    // The classic float trap: 0.1 + 0.2 would be 0.30000000000000004
    expect(parseCedis("0.1") + parseCedis("0.2")).toBe(parseCedis("0.3"));
  });

  it("rejects anything that isn't a plain amount", () => {
    for (const bad of ["", "abc", "-5", "1.005", "1e3", "12345678", "10.", ".5"]) {
      expect(() => parseCedis(bad), bad).toThrow(/Enter an amount/);
    }
  });

  it("formats pesewas for people", () => {
    expect(formatCedis(105050)).toBe("GH₵ 1,050.50");
    expect(formatCedis(5)).toBe("GH₵ 0.05");
    expect(formatCedis(-2000)).toBe("−GH₵ 20.00");
    expect(() => formatCedis(1.5)).toThrow();
  });
});

describe("schedule", () => {
  it("spaces daily and weekly rounds evenly, across month and year ends", () => {
    expect(roundDueDates("2026-12-30", "daily", 4)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(roundDueDates("2026-12-24", "weekly", 3)).toEqual(["2026-12-24", "2026-12-31", "2027-01-07"]);
  });

  it("keeps the monthly due day, falling back to the last day of short months", () => {
    expect(roundDueDates("2027-01-31", "monthly", 5)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
    // 2028 is a leap year
    expect(roundDueDates("2028-01-30", "monthly", 3)).toEqual(["2028-01-30", "2028-02-29", "2028-03-30"]);
    expect(roundDueDates("2026-11-15", "monthly", 3)).toEqual(["2026-11-15", "2026-12-15", "2027-01-15"]);
  });

  it("rejects dates that don't exist", () => {
    expect(parseIsoDate("2027-02-29")).toBeNull();
    expect(parseIsoDate("2027-13-01")).toBeNull();
    expect(parseIsoDate("27-1-1")).toBeNull();
    expect(parseIsoDate("2028-02-29")).not.toBeNull();
  });
});

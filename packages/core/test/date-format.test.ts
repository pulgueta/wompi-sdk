import { describe, it } from "vitest";

import { createYYYYMMDD, isValidYYYYMMDD } from "../src/client/utils/date-format";

describe("date-format.ts", () => {
  it("should validate a date in the format YYYY-MM-DD", ({ expect }) => {
    const date = "2021-01-01";

    expect(isValidYYYYMMDD(date)).toBe(true);
  });

  it("should return false if date format is not YYYY-MM-DD", ({ expect }) => {
    const date = "21-2021-06";

    expect(isValidYYYYMMDD(date)).toBe(false);
  });

  it("should get the date from an input", ({ expect }) => {
    // 7 is because months are 0-indexed
    const date = new Date(2026, 7, 16);

    const dateToExpect = createYYYYMMDD(date);

    expect(dateToExpect).toBe("2026-08-16");
  });
});

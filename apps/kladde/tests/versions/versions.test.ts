import { expect, test } from "vitest";
import {
  byDay,
  cleanLabel,
  dayTitle,
  MAX_LABEL_CHARS,
} from "../../src/versions/versions";

function at(day: number, hour: number) {
  return new Date(2026, 10, day, hour).getTime() / 1000;
}

function version(rev: number, time: number) {
  return { rev, time, label: null, cause: null };
}

test("versions are grouped by local calendar day in list order", () => {
  const listed = [
    version(9, at(18, 9)),
    version(8, at(18, 0)),
    version(7, at(17, 23)),
    version(4, at(3, 12)),
  ];
  const days = byDay(listed);

  expect(days.map((day) => day.versions.map((v) => v.rev))).toEqual([
    [9, 8],
    [7],
    [4],
  ]);
  expect(days[0].day).toBe(new Date(2026, 10, 18).getTime());
  expect(byDay([])).toEqual([]);
});

test("recent days are named, older ones dated", () => {
  const now = new Date(2026, 10, 18, 15).getTime();
  const day = (date: number, month = 10, year = 2026) =>
    new Date(year, month, date).getTime();

  expect(dayTitle(day(18), now, "de")).toBe("Heute");
  expect(dayTitle(day(17), now, "de")).toBe("Gestern");
  expect(dayTitle(day(17), now, "en")).toBe("Yesterday");
  expect(dayTitle(day(3), now, "de")).toBe("Dienstag, 3. November");
  expect(dayTitle(day(24, 11, 2025), now, "de")).toBe(
    "Mittwoch, 24. Dezember 2025",
  );
});

test("a label is trimmed, printable and bounded", () => {
  expect(cleanLabel("  Vor dem\nUmbau\t ")).toBe("Vor dem Umbau");
  expect(cleanLabel(" \n ")).toBe("");
  expect(Array.from(cleanLabel("😀".repeat(200)))).toHaveLength(
    MAX_LABEL_CHARS,
  );
});

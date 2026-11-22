import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { since } from "../../src/workspace/since";
import type { T } from "../../src/locale/locale";

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const t = ((key: string) => key) as T;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("relative edit time", () => {
  it("says just now below half a minute and for times in the future", () => {
    expect(since(NOW - 29 * SECOND, "en", t)).toBe("justNow");
    expect(since(NOW + 10 * MINUTE, "en", t)).toBe("justNow");
  });

  it("switches to minutes from half a minute on", () => {
    expect(since(NOW - 31 * SECOND, "en", t)).toBe("1 minute ago");
    expect(since(NOW - 59 * MINUTE, "en", t)).toBe("59 minutes ago");
  });

  it("switches to hours once the minutes round up to sixty", () => {
    expect(since(NOW - 59 * MINUTE - 29 * SECOND, "en", t)).toBe(
      "59 minutes ago",
    );
    expect(since(NOW - 59 * MINUTE - 31 * SECOND, "en", t)).toBe("1 hour ago");
    expect(since(NOW - 23 * HOUR, "en", t)).toBe("23 hours ago");
  });

  it("shows a calendar date from one day on", () => {
    expect(since(NOW - 24 * HOUR, "en", t)).toBe("Nov 21, 2026");
    expect(since(NOW - 400 * 24 * HOUR, "en", t)).toBe("Oct 18, 2025");
  });

  it("formats in the requested language", () => {
    expect(since(NOW - 5 * MINUTE, "de", t)).toBe("vor 5 Minuten");
    expect(since(NOW - 2 * HOUR, "de", t)).toBe("vor 2 Stunden");
  });
});

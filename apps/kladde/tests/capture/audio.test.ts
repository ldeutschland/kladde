import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/platform/native", () => ({ command: vi.fn() }));

const {
  clock,
  failureWord,
  languageName,
  recorderReducer,
  recordingName,
  transcriptBlocks,
} = await import("../../src/capture/audio");

const idle = {
  phase: "idle" as const,
  seconds: 0,
  level: 0,
  settled: "",
  pending: "",
  model: false,
  error: "",
};

describe("recorder state", () => {
  it("follows the native phases and ignores unknown ones", () => {
    const starting = { ...idle, phase: "starting" as const };
    const recording = recorderReducer(starting, {
      kind: "state",
      state: "recording",
    });

    expect(recording.phase).toBe("recording");
    const paused = recorderReducer(recording, {
      kind: "state",
      state: "paused",
    });

    expect(paused.phase).toBe("paused");
    expect(recorderReducer(paused, { kind: "state", state: "x" })).toBe(paused);
    expect(recorderReducer(paused, { kind: "other" })).toBe(paused);
  });

  it("treats the first level as the start when the state event was missed", () => {
    const starting = { ...idle, phase: "starting" as const };
    const heard = recorderReducer(starting, {
      kind: "level",
      seconds: 1.5,
      level: 4,
    });

    expect(heard).toMatchObject({ phase: "recording", seconds: 1.5, level: 1 });
    const paused = { ...heard, phase: "paused" as const };

    expect(
      recorderReducer(paused, { kind: "level", seconds: 2, level: -1 }),
    ).toMatchObject({ phase: "paused", level: 0 });
  });

  it("keeps settled and pending text apart and rejects other types", () => {
    const heard = recorderReducer(
      { ...idle, phase: "recording", model: true },
      { kind: "text", settled: "Hallo.", pending: "Wie" },
    );

    expect(heard).toMatchObject({
      settled: "Hallo.",
      pending: "Wie",
      model: false,
    });
    expect(
      recorderReducer(heard, { kind: "text", settled: 7, pending: null }),
    ).toMatchObject({ settled: "", pending: "" });
  });

  it("returns to idle when the recording ends or fails", () => {
    const recording = { ...idle, phase: "recording" as const, seconds: 9 };

    expect(recorderReducer(recording, { kind: "done" })).toEqual(idle);
    expect(
      recorderReducer(recording, { kind: "failed", reason: "microphone" }),
    ).toEqual({ ...idle, error: "microphone" });
    expect(recorderReducer(recording, { kind: "failed" }).error).toBe("failed");
  });
});

describe("recording helpers", () => {
  it("formats durations with and without hours", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65.9)).toBe("1:05");
    expect(clock(3723)).toBe("1:02:03");
    expect(clock(-4)).toBe("0:00");
  });

  it("names a recording without path separators", () => {
    const name = recordingName("Sprachnotiz", "de", new Date(2026, 10, 18, 9));

    expect(name).toMatch(/^Sprachnotiz .*\.m4a$/);
    expect(name).not.toMatch(/[/:]/);
  });

  it("turns a transcript into paragraphs", () => {
    expect(transcriptBlocks(" Eins.\n\n\nZwei.\nDrei. \n\n ")).toEqual([
      { type: "paragraph", content: "Eins." },
      { type: "paragraph", content: "Zwei.\nDrei." },
    ]);
    expect(transcriptBlocks("  ")).toEqual([]);
  });

  it("maps failures to messages and names languages", () => {
    expect(failureWord("microphone")).toBe("recordNoMicrophone");
    expect(failureWord("input")).toBe("recordNoInput");
    expect(failureWord("Error: Native application required")).toBe(
      "recordNative",
    );
    expect(failureWord("anything")).toBe("recordFailed");
    expect(languageName("de-DE", "de")).toContain("Deutsch");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  confirm: true,
  calls: [] as [string, unknown][],
}));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: unknown) => {
    native.calls.push([name, args]);
    if (name === "clip_inbox_preview")
      return {
        kind: "link",
        title: "Bank",
        url: "https://bank.example/login",
        confirm: native.confirm,
      };

    return undefined;
  }),
}));

const { approveClip } = await import("../../src/workspace/useClipInbox");
const t = (key: string) =>
  key === "clipConfirmDetail" ? "{title} · {url}" : key;

beforeEach(() => {
  native.confirm = true;
  native.calls = [];
});

describe("clips from the browser extension", () => {
  it("are only taken after the person says yes", async () => {
    const ask = vi.fn(async () => "yes");

    expect(await approveClip({ t, ask } as never, "c1")).toBe(true);
    expect(ask).toHaveBeenCalledWith("clipConfirm", undefined, {
      detail: "Bank · https://bank.example/login",
      action: "apply",
    });
    expect(native.calls.map(([name]) => name)).toEqual(["clip_inbox_preview"]);
  });

  it("are discarded when the question is cancelled", async () => {
    const ask = vi.fn(async () => null);

    expect(await approveClip({ t, ask } as never, "c1")).toBe(false);
    expect(native.calls).toContainEqual([
      "finish_clip_inbox_item",
      { id: "c1" },
    ]);
  });

  it("need no question when they come from the share sheet", async () => {
    const ask = vi.fn(async () => null);

    native.confirm = false;
    expect(await approveClip({ t, ask } as never, "c1")).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

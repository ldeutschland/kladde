import { describe, expect, it } from "vitest";
import { BLANK, imageLayout } from "../../src/viewer/imageLayout";
import type { ImageDraft } from "../../src/viewer/imageExport";

const PADDING = 24;
const PHONE_PADDING = 8;
const SMALLEST_FIT = 0.01;

function layout(
  size: [number, number] | null,
  stage: [number, number],
  options: Partial<{
    draft: ImageDraft;
    cropping: boolean;
    zoom: number;
    mobile: boolean;
  }> = {},
) {
  const image = size
    ? ({ naturalWidth: size[0], naturalHeight: size[1] } as HTMLImageElement)
    : undefined;

  return imageLayout({
    image,
    draft: BLANK,
    cropping: false,
    zoom: 1,
    mobile: false,
    stage: { width: stage[0], height: stage[1] },
    ...options,
  });
}

describe("image layout", () => {
  it("never enlarges a small image beyond its natural size", () => {
    expect(layout([100, 50], [2000, 2000]).scale).toBe(1);
    expect(layout([100, 50], [2000, 2000], { zoom: 3 }).scale).toBe(3);
  });

  it("fits a large image inside the padded stage on its tighter side", () => {
    const wide = layout([4000, 1000], [1048, 1048]);

    expect(wide.scale).toBeCloseTo((1048 - 2 * PADDING) / 4000);
    const phone = layout([1000, 4000], [400, 816], { mobile: true });

    expect(phone.padding).toBe(PHONE_PADDING);
    expect(phone.scale).toBeCloseTo((816 - 2 * PHONE_PADDING) / 4000);
  });

  it("measures a quarter-turned image with swapped sides", () => {
    const turned = layout([4000, 1000], [1048, 1048], {
      draft: { ...BLANK, turn: 90 },
    });

    expect(turned.box).toEqual({ x: 0, y: 0, width: 1000, height: 4000 });
    expect(turned.scale).toBeCloseTo((1048 - 2 * PADDING) / 4000);
  });

  it("fits the crop while viewing but the whole image while cropping", () => {
    const crop = { x: 100, y: 100, width: 200, height: 100 };
    const draft = { ...BLANK, crop };
    const viewing = layout([2000, 2000], [448, 448], { draft });
    const cropping = layout([2000, 2000], [448, 448], {
      draft,
      cropping: true,
    });

    expect(viewing.box).toEqual(crop);
    expect(viewing.scale).toBe(1);
    expect(cropping.box).toMatchObject({ width: 2000, height: 2000 });
    expect(cropping.scale).toBeCloseTo(400 / 2000);
  });

  it("keeps a minimum scale when the stage is smaller than its padding", () => {
    expect(layout([500, 500], [10, 10]).scale).toBe(SMALLEST_FIT);
    expect(layout([500, 500], [0, -50], { zoom: 2 }).scale).toBe(
      SMALLEST_FIT * 2,
    );
  });

  it("uses a one-pixel placeholder until the image has loaded", () => {
    const pending = layout(null, [800, 600]);

    expect([pending.width, pending.height]).toEqual([1, 1]);
    expect(Number.isFinite(pending.scale)).toBe(true);
  });
});

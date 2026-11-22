import { visibleBox, type ImageDraft } from "./imageExport";
import { sheetMatrix, turnedSize, type Box } from "./marks";

const PADDING = 24;
const PHONE_PADDING = 8;
const SMALLEST_FIT = 0.01;

export const BLANK: ImageDraft = {
  turn: 0,
  flip: false,
  crop: null,
  marks: [],
};

interface LayoutInput {
  image: HTMLImageElement | undefined;
  draft: ImageDraft;
  cropping: boolean;
  stage: { width: number; height: number };
  zoom: number;
  mobile: boolean;
}

export function imageLayout(input: LayoutInput) {
  const { draft, stage } = input;
  const width = input.image?.naturalWidth ?? 1,
    height = input.image?.naturalHeight ?? 1;
  const matrix = sheetMatrix(width, height, draft.turn, draft.flip);
  const [shownWidth, shownHeight] = turnedSize(width, height, draft.turn);
  const whole: Box = { x: 0, y: 0, width: shownWidth, height: shownHeight };
  const box = input.cropping ? whole : visibleBox(width, height, draft);
  const padding = input.mobile ? PHONE_PADDING : PADDING;
  const fit = Math.min(
    (stage.width - 2 * padding) / box.width,
    (stage.height - 2 * padding) / box.height,
    1,
  );

  return {
    width,
    height,
    matrix,
    whole,
    box,
    padding,
    scale: Math.max(fit, SMALLEST_FIT) * input.zoom,
  };
}

export type ImageLayout = ReturnType<typeof imageLayout>;

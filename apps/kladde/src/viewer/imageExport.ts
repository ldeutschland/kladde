import {
  MARKER_OPACITY,
  TEXT_BASELINE,
  TEXT_FONT,
  TEXT_INSET,
  TEXT_LINE,
  apply,
  arrowHead,
  boxOf,
  invert,
  mapBox,
  sheetMatrix,
  textLines,
  turnedSize,
  type Box,
  type Mark,
  type Matrix,
  type Point,
  type Turn,
} from "./marks";

export interface ImageDraft {
  turn: Turn;
  flip: boolean;
  crop: Box | null;
  marks: Mark[];
}

export const MAX_PIXELS = 16_777_216;
const QUALITY = 0.92;
const KEPT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const OPAQUE = new Set(["image/jpeg"]);

export function outputType(type: string) {
  return KEPT_TYPES.has(type) ? type : "image/png";
}

export function visibleBox(
  width: number,
  height: number,
  draft: ImageDraft,
): Box {
  const m = sheetMatrix(width, height, draft.turn, draft.flip);

  if (draft.crop) return mapBox(m, draft.crop);
  const [shownWidth, shownHeight] = turnedSize(width, height, draft.turn);

  return { x: 0, y: 0, width: shownWidth, height: shownHeight };
}

export function outputScale(box: Box) {
  return Math.min(1, Math.sqrt(MAX_PIXELS / (box.width * box.height)));
}

function trace(context: CanvasRenderingContext2D, points: Point[]) {
  context.beginPath();
  points.forEach(([x, y], i) =>
    i ? context.lineTo(x, y) : context.moveTo(x, y),
  );
  if (points.length === 1) context.lineTo(points[0][0], points[0][1]);
  context.stroke();
}

function drawText(context: CanvasRenderingContext2D, mark: Mark, m: Matrix) {
  const [x, y] = apply(m, mark.points[0]);

  context.save();
  context.transform(...invert(m));
  context.translate(x, y);
  context.fillStyle = mark.color;
  context.font = `${mark.width}px ${TEXT_FONT}`;
  textLines(mark).forEach((line, i) =>
    context.fillText(
      line,
      mark.width * TEXT_INSET,
      mark.width * (TEXT_BASELINE + i * TEXT_LINE),
    ),
  );
  context.restore();
}

function drawMark(context: CanvasRenderingContext2D, mark: Mark, m: Matrix) {
  if (mark.kind === "text") {
    drawText(context, mark, m);

    return;
  }

  context.save();
  context.strokeStyle = mark.color;
  context.lineWidth = mark.width;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (mark.kind === "marker") {
    context.globalAlpha = MARKER_OPACITY;
    context.globalCompositeOperation = "multiply";
  }

  if (mark.kind === "rect") {
    const { x, y, width, height } = boxOf(mark.points);

    context.lineCap = "butt";
    context.strokeRect(x, y, width, height);
  } else {
    trace(context, mark.points);
    if (mark.kind === "arrow") trace(context, arrowHead(mark));
  }

  context.restore();
}

export async function renderImage(
  image: HTMLImageElement,
  draft: ImageDraft,
  type: string,
): Promise<Blob> {
  const width = image.naturalWidth,
    height = image.naturalHeight;
  const box = visibleBox(width, height, draft);
  const scale = outputScale(box);
  const canvas = document.createElement("canvas");

  canvas.width = Math.max(1, Math.round(box.width * scale));
  canvas.height = Math.max(1, Math.round(box.height * scale));
  const context = canvas.getContext("2d");

  if (!context) throw Error("Canvas unavailable");

  if (OPAQUE.has(type)) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  const m = sheetMatrix(width, height, draft.turn, draft.flip);

  context.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
  context.transform(...m);
  context.drawImage(image, 0, 0, width, height);
  for (const mark of draft.marks) drawMark(context, mark, m);

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(Error("Image could not be saved")),
      type,
      QUALITY,
    ),
  );
}

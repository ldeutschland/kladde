import { useState } from "react";
import type { ImageDraft } from "./imageExport";
import { invert, mapBox, type Box } from "./marks";
import type { ImageLayout } from "./imageLayout";

const FULL_TOLERANCE = 0.5;

interface DraftHistory {
  commit: (update: (draft: ImageDraft) => ImageDraft) => void;
}

export function useImageCrop() {
  const [frame, setFrame] = useState<Box | null>(null);

  function start(draft: ImageDraft, layout: ImageLayout) {
    setFrame(draft.crop ? mapBox(layout.matrix, draft.crop) : layout.whole);
  }

  function apply(history: DraftHistory, layout: ImageLayout) {
    if (!frame) return;
    const { whole } = layout;
    const full =
      frame.width >= whole.width - FULL_TOLERANCE &&
      frame.height >= whole.height - FULL_TOLERANCE;
    const crop = full ? null : mapBox(invert(layout.matrix), frame);

    history.commit((draft) => ({ ...draft, crop }));
    setFrame(null);
  }

  return { frame, setFrame, start, apply, cancel: () => setFrame(null) };
}

export type ImageCrop = ReturnType<typeof useImageCrop>;

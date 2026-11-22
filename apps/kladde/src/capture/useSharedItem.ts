import { useEffect, useState } from "react";
import { sharedItem } from "./sharedItem";
import type { CaptureDraft } from "./useCaptureDraft";

export function useSharedItem(shared: string[], draft: CaptureDraft) {
  const [item, setItem] = useState(shared[0] ?? ""),
    [loading, setLoading] = useState(!!shared.length);

  useEffect(() => {
    if (!item) return;
    let active = true;

    setLoading(true);
    sharedItem(item)
      .then((result) => {
        if (!active) return;
        draft.setText(result.text);
        draft.setFile(result.file);
        draft.setClip(false);
      })
      .catch((problem) => {
        if (!active) return;
        draft.fail(String(problem));
        setItem("");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [item]);

  function pick(next: string) {
    draft.setText("");
    draft.setFile(undefined);
    draft.fail("");
    setItem(next);
  }

  return { item, loading, pick };
}

export type SharedItemState = ReturnType<typeof useSharedItem>;

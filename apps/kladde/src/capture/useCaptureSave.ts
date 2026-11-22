import { useRef, useState } from "react";
import { Notebook } from "../notebook/notebook";
import { command } from "../platform/native";
import { saveClip, saveNote } from "./saveNote";
import type { CaptureProps, Draft, RecorderControls } from "./types";
import type { CaptureDraft } from "./useCaptureDraft";
import type { SharedItemState } from "./useSharedItem";

interface SaveOptions {
  props: CaptureProps;
  draft: CaptureDraft;
  shared: SharedItemState;
  recorder: RecorderControls;
  lang: string;
}

export function useCaptureSave(options: SaveOptions) {
  const { props, draft } = options;
  const { book, t } = props;
  const [space, choose] = useState(book.id),
    [busy, setBusy] = useState(false),
    [draftId] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);

  async function write(target: Notebook, key: string, note: Draft) {
    if (draft.clips(note)) {
      await saveClip(target, key, note.text, t);

      return;
    }

    await saveNote({
      target,
      key,
      draft: note,
      file: draft.file,
      recorder: options.recorder,
      t,
      lang: options.lang,
    });
  }

  async function store(note: Draft, notice = "") {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    draft.fail("");

    try {
      const { item } = options.shared;
      const target = space === book.id ? book : await Notebook.open(space);
      const key = item || draftId;

      await write(target, key, note);
      await target.flush();
      if (item) await command("finish_shared_item", { id: item });
      props.saved(space, key, notice);
    } catch (problem) {
      draft.fail(String(problem));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function save() {
    if (options.shared.loading || draft.recording || !draft.content) return;
    await store({ text: draft.text, spoken: draft.spoken });
  }

  return { space, choose, busy, store, save };
}

export type CaptureSave = ReturnType<typeof useCaptureSave>;

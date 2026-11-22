import { useState } from "react";
import type { ViewerProps } from "./viewing";

export interface SavedEdit {
  url: string;
  name: string;
}

export function useEditSave(
  props: ViewerProps,
  write: (copy: boolean) => Promise<SavedEdit>,
) {
  const { t, notify } = props;
  const [saving, setSaving] = useState(false);

  async function save(copy: boolean) {
    setSaving(true);

    try {
      const saved = await write(copy);

      if (!props.place(saved.url, saved.name, copy))
        throw Error(t("blockMissing"));
      notify(t(copy ? "editCopied" : "editSaved"));
    } catch (problem) {
      notify(t("editFailed").replace("{error}", String(problem)));
      setSaving(false);
    }
  }

  return { saving, save };
}

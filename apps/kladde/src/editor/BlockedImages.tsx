import type { ChangeEvent } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { saveFile } from "../files/attachments";

const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";
const REMOTE_URL = /^https?:/i;

export function BlockedImages({
  editor,
  book,
  entry,
  t,
}: {
  editor: BlockNoteEditor;
  book: Notebook;
  entry: Entry;
  t: T;
}) {
  const blocked = editor.document.filter(
    (block) => block.type === "image" && REMOTE_URL.test(block.props.url),
  );

  async function replace(id: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) return;
    const url = await saveFile(book, entry, file);

    editor.updateBlock(id, { type: "image", props: { url } });
  }

  return blocked.map((block) => (
    <label className="blockedasset" key={block.id}>
      {t("blockedImage")}{" "}
      <input
        type="file"
        accept={IMAGE_TYPES}
        onChange={(event) => void replace(block.id, event)}
      />
    </label>
  ));
}

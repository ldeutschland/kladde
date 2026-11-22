import { fileMeta, saveFile } from "../files/attachments";
import { outputType, renderImage, type ImageDraft } from "./imageExport";
import { keepBefore } from "../versions/versions";
import { noteSavedEdit } from "../files/fileEdits";
import { fileId, savedName, type ViewerProps } from "./viewing";
import type { SavedEdit } from "./useEditSave";

export async function saveImage(
  props: ViewerProps,
  image: HTMLImageElement,
  draft: ImageDraft,
  copy: boolean,
): Promise<SavedEdit> {
  const { book, entry, target, t } = props;
  const type = outputType(fileMeta(entry, fileId(target.url))?.type ?? "");
  const blob = await renderImage(image, draft, type);
  const name = savedName(target.name, blob.type, copy, t);

  await keepBefore(book, entry, "file");
  const url = await saveFile(
    book,
    entry,
    new File([blob], name, { type: blob.type }),
  );

  if (!copy) await noteSavedEdit(book, entry, target, fileId(url));

  return { url, name };
}

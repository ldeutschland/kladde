import { recordFile, storedParts } from "../files/attachments";
import { command } from "../platform/native";
import { keepBefore } from "../versions/versions";
import { noteSavedEdit } from "../files/fileEdits";
import { savedName, type ViewerProps } from "./viewing";
import type { PdfSource } from "./pdfPages";
import type { PageDraft } from "./pdfDraft";
import type { SavedEdit } from "./useEditSave";

const PDF_TYPE = "application/pdf";
const FILE_SCHEME = "kladde-file:";

export async function savePdf(
  props: ViewerProps,
  source: PdfSource,
  pages: PageDraft[],
  copy: boolean,
): Promise<SavedEdit> {
  const { book, entry, target, t } = props;

  await keepBefore(book, entry, "file");
  const edit = {
    pages: pages.map(({ source, turn, marks }) => ({ source, turn, marks })),
  };
  const saved = await command<{
    parts?: unknown;
    sha256?: unknown;
    size?: unknown;
  }>("edit_pdf", {
    ...source,
    edit,
  });
  const stored = storedParts(saved);

  if (typeof saved.size !== "number" || saved.size < 0)
    throw Error("Invalid file");
  const name = savedName(target.name, PDF_TYPE, copy, t);
  const id = recordFile(entry, stored, {
    type: PDF_TYPE,
    name,
    size: saved.size,
  });

  if (!copy) await noteSavedEdit(book, entry, target, id);
  await book.flush();

  return { url: FILE_SCHEME + id, name };
}

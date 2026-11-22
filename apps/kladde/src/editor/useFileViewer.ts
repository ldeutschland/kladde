import { useState, type MouseEvent } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { setFileContext } from "./FileBlock";
import { isLocalFile, type ViewTarget } from "../viewer/viewing";
import {
  defaultLanguage,
  transcribeStored,
  transcriptBlocks,
} from "../capture/audio";
import { BLOCK_SELECTOR } from "./selectionDom";

const IMAGE_SELECTOR = "[data-content-type='image'] img.bn-visual-media";
const FILE_SCHEME = "kladde-file:";

interface FileViewerOptions {
  editor: BlockNoteEditor;
  book: Notebook;
  entry: Entry;
  lang: string;
  t: T;
  mobile: boolean;
  notify: (text: string) => void;
}

interface StoredFile {
  block: string;
  url: string;
  name: string;
}

async function transcribeFile(options: FileViewerOptions, file: StoredFile) {
  const { editor, book, entry, t, notify } = options;

  notify(t("transcribing"));

  try {
    await book.flush();
    const language = defaultLanguage(book, options.lang);
    const id = file.url.slice(FILE_SCHEME.length);
    const heard = await transcribeStored(book, entry, id, file.name, language);
    const blocks = transcriptBlocks(heard.text);

    if (!blocks.length || !editor.getBlock(file.block)) {
      notify(t("transcriptNone"));

      return;
    }

    editor.insertBlocks(blocks, file.block, "after");
    notify(t("transcribed"));
  } catch (problem) {
    notify(t("recordFailed").replace("{error}", String(problem)));
  }
}

function placeFile(
  editor: BlockNoteEditor,
  target: ViewTarget,
  file: { url: string; name: string; copy: boolean },
) {
  const { url, name } = file;
  const block = editor.getBlock(target.block);
  const placed = {
    ...target,
    url,
    name,
    edit: false,
    page: undefined,
    found: undefined,
  };

  if (block && !file.copy) {
    editor.updateBlock(block, { props: { url, name } });

    return placed;
  }

  const reference = block ?? editor.document.at(-1);

  if (!reference) return null;
  const props = { url, name };
  const created =
    target.kind === "image"
      ? { type: "image" as const, props }
      : { type: "file" as const, props };
  const [inserted] = editor.insertBlocks([created], reference, "after");

  return { ...placed, block: inserted.id };
}

export function useFileViewer(options: FileViewerOptions) {
  const { editor, book, entry, t } = options;
  const [viewing, setViewing] = useState<ViewTarget | null>(null);

  setFileContext(editor, {
    book,
    entry,
    t,
    transcribe: (block, url, name) =>
      void transcribeFile(options, { block, url, name }),
    view: setViewing,
  });

  function viewImage(event: MouseEvent<HTMLElement>) {
    const image = (event.target as Element).closest(IMAGE_SELECTOR);
    const id = image?.closest(BLOCK_SELECTOR)?.getAttribute("data-id");
    const block = id ? editor.getBlock(id) : undefined;

    if (!id || block?.type !== "image" || !isLocalFile(block.props.url)) return;
    event.preventDefault();
    setViewing({
      block: id,
      url: block.props.url,
      name: block.props.name,
      kind: "image",
    });
  }

  const viewer = viewing && {
    book,
    entry,
    target: viewing,
    t,
    mobile: options.mobile,
    notify: options.notify,
    close: () => setViewing(null),
    place: (url: string, name: string, copy: boolean) => {
      const next = placeFile(editor, viewing, { url, name, copy });

      if (next) setViewing(next);

      return !!next;
    },
  };

  return { setViewing, viewImage, viewer };
}

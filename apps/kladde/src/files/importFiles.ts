import * as Y from "yjs";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { blockEditor, markdown, writeMarkdown } from "../notebook/content";
import { fileBlockType, saveFile } from "./attachments";
import { importCsv } from "../database/csv";
import type { Notebook } from "../notebook/notebook";
import { importNotion, looksLikeNotion } from "../notionImport/notionImport";

const IMPORTABLE = /\.(md|csv)$/i;

export const importExtensions =
  ".zip,.md,.csv,.pdf,.png,.jpg,.jpeg,.heic,.heif,.avif,.tif,.tiff,.gif,.webp,.bmp,.txt,.log,.tsv,.json,.docx,.pptx,.xlsx,.odt,.ods,.odp";
const extensions = new Set(importExtensions.split(","));
const FILE_LIMIT = 8_000_000;
const COUNT_LIMIT = 1000;
const STORED_TEXT_BYTES = 2_000_000;
const STORED_STATE_BYTES = 4_194_304;
const MARKDOWN_TOO_LARGE = "Markdown too large";

export function importable(file: File) {
  if (IMPORTABLE.test(file.name)) return file.size <= FILE_LIMIT;

  return extensions.has(
    file.name.slice(file.name.lastIndexOf(".")).toLowerCase(),
  );
}

function folderFor(
  book: Notebook,
  file: File,
  root: string | null,
  folders: Map<string, string>,
) {
  let parent = root;
  let path = "";

  for (const component of file.webkitRelativePath.split("/").slice(1, -1)) {
    path += "/" + component;
    if (!folders.has(path))
      folders.set(path, book.add(component, "page", parent).id);
    parent = folders.get(path)!;
  }

  return parent;
}

async function importOne(book: Notebook, file: File, parent: string | null) {
  if (!IMPORTABLE.test(file.name)) {
    const entry = book.add(file.name, "page", parent);

    try {
      const url = await saveFile(book, entry, file);
      const editor = blockEditor();
      const { insertedBlocks } = editor.replaceBlocks(editor.document, [
        { type: fileBlockType(file), props: { name: file.name, url } },
      ]);

      blocksToYXmlFragment(
        editor,
        insertedBlocks,
        entry.doc.getXmlFragment("blocks"),
      );
      entry.doc.getMap("meta").set("text", markdown(entry));

      return entry.id;
    } catch (error) {
      await book.trashBranch(entry.id, Date.now());
      throw error;
    }
  }

  const name = file.name.replace(IMPORTABLE, "");
  const text = await file.text();

  if (/\.csv$/i.test(file.name))
    return (await importCsv(book, name, text, parent)).id;

  return importMarkdown(book, name, text, parent);
}

function importMarkdown(
  book: Notebook,
  name: string,
  text: string,
  parent: string | null,
) {
  if (new TextEncoder().encode(text).length > STORED_TEXT_BYTES)
    throw Error(MARKDOWN_TOO_LARGE);
  const entry = book.add(name, "page", parent);

  writeMarkdown(entry, text);
  if (Y.encodeStateAsUpdate(entry.doc).length <= STORED_STATE_BYTES)
    return entry.id;
  book.discardUnsaved(entry.id);
  throw Error(MARKDOWN_TOO_LARGE);
}

export async function importFiles(
  book: Notebook,
  list: File[],
  root: string | null = null,
) {
  if (looksLikeNotion(list))
    return (await importNotion(book, list, { root, remoteImages: false }))
      .first;
  if (list.length > COUNT_LIMIT) throw Error("Import limit");
  const files = list.filter(importable);
  const folders = new Map<string, string>();
  let first = "";

  for (const file of files) {
    const parent = folderFor(book, file, root, folders);
    const id = await importOne(book, file, parent);

    first ||= id;
  }

  await book.flush();

  return first;
}

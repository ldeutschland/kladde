import { useEffect, useMemo } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { CollaborationExtension } from "@blocknote/core/yjs";
import { de, en } from "@blocknote/core/locales";
import type { BlockNoteEditor } from "@blocknote/core";
import { syntaxHighlighter } from "@blocknote/code-block";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { localFile, saveFile } from "../files/attachments";
import { isValidLink, linkedPage } from "../notebook/links";
import { schema } from "./schema";

const CURSOR_COLOR = "#7f63d9";

interface EditorOptions {
  book: Notebook;
  entry: Entry;
  lang: string;
  t: T;
  aiEnabled: boolean;
  excluded: boolean;
  notify: (text: string) => void;
}

function clickedPageLink(event: MouseEvent) {
  const anchor = (event.target as Element | null)?.closest("a");

  return !!linkedPage(anchor?.getAttribute("href") ?? "");
}

function editorDictionary(lang: string, t: T, aiReady: boolean) {
  const words = lang === "en" ? en : de;

  if (!aiReady) return words;

  return {
    ...words,
    placeholders: { ...words.placeholders, default: t("placeholderAi") },
  };
}

export function useNotebookEditor(options: EditorOptions) {
  const { book, entry, lang, t, aiEnabled, excluded, notify } = options;
  const files = useMemo(() => new Map<string, string>(), [entry]);
  const editor = useCreateBlockNote(
    {
      schema,
      dictionary: editorDictionary(lang, t, aiEnabled && !excluded),
      extensions: [
        syntaxHighlighter,
        CollaborationExtension({
          fragment: entry.doc.getXmlFragment("blocks"),
          user: { name: "", color: CURSOR_COLOR },
        }),
      ],
      links: { isValidLink, onClick: clickedPageLink },
      uploadFile: async (file: File, blockId?: string) => {
        try {
          return await saveFile(book, entry, file);
        } catch (problem) {
          if (blockId && editor.getBlock(blockId))
            editor.removeBlocks([blockId]);
          notify(t("uploadFailed"));
          throw problem;
        }
      },
      resolveFileUrl: async (url: string) => {
        const cached = files.get(url);

        if (cached) return cached;
        const local = await localFile(book, entry, url);

        if (local) files.set(url, local);

        return local;
      },
    },
    [entry, lang, aiEnabled, excluded],
  );

  return { editor, files };
}

export function useRegisteredEditor(
  editor: BlockNoteEditor,
  files: Map<string, string>,
  register: (editor: BlockNoteEditor | null) => void,
) {
  useEffect(() => {
    register(editor);

    return () => {
      register(null);
      for (const url of files.values()) URL.revokeObjectURL(url);
    };
  }, [editor, files, register]);
}

export function storePlainText(editor: BlockNoteEditor, entry: Entry) {
  const text = editor.blocksToMarkdownLossy();
  const meta = entry.doc.getMap("meta");

  if (meta.get("text") !== text) meta.set("text", text);
}

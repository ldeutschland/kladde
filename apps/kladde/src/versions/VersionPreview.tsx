import { useEffect, useMemo } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { CollaborationExtension } from "@blocknote/core/yjs";
import { syntaxHighlighter } from "@blocknote/code-block";
import { localFile } from "../files/attachments";
import { schema } from "../editor/schema";
import { setFileContext } from "../editor/FileBlock";
import { setPageLinkContext } from "../editor/pageLinkSpec";
import { isValidLink } from "../notebook/links";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";

export function VersionPreview({
  book,
  old,
  title,
  dark,
  t,
}: {
  book: Notebook;
  old: Entry;
  title: string;
  dark: boolean;
  t: T;
}) {
  const files = useMemo(() => new Map<string, string>(), [old]);
  const editor = useCreateBlockNote(
    {
      schema,
      extensions: [
        syntaxHighlighter,
        CollaborationExtension({
          fragment: old.doc.getXmlFragment("blocks"),
          user: { name: "", color: "#7f63d9" },
        }),
      ],
      links: { isValidLink, onClick: () => true },
      resolveFileUrl: async (url: string) => {
        const cached = files.get(url);

        if (cached) return cached;
        const local = await localFile(book, old, url);

        if (local) files.set(url, local);

        return local;
      },
    },
    [old],
  );

  setFileContext(editor, { book, entry: old, t });
  setPageLinkContext(editor, { book, t });
  useEffect(
    () => () => {
      for (const url of files.values()) URL.revokeObjectURL(url);
    },
    [files],
  );

  return (
    <div
      className="writing versionpreview"
      onClickCapture={(event) => {
        if ((event.target as Element).closest("a")) event.preventDefault();
      }}
    >
      <h3>{title || t("untitled")}</h3>
      <BlockNoteView
        editor={editor}
        editable={false}
        theme={dark ? "dark" : "light"}
        slashMenu={false}
        sideMenu={false}
        formattingToolbar={false}
      />
    </div>
  );
}

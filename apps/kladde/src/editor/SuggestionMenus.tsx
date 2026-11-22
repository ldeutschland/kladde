import {
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
} from "@blocknote/react";
import { filterSuggestionItems, type BlockNoteEditor } from "@blocknote/core";
import {
  FileText,
  Lightbulb,
  Mic,
  PenLine,
  Sparkles,
  Table2,
} from "lucide-react";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T, Word } from "../locale/locale";
import { insertPageLink, pageSuggestions } from "./pageLinks";

const ICON_SIZE = 18;
const AUDIO_ALIASES = [
  "audio",
  "aufnahme",
  "sprachnotiz",
  "diktat",
  "mikrofon",
  "voice",
  "record",
];

export interface SuggestionMenusProps {
  editor: BlockNoteEditor;
  book: Notebook;
  entry: Entry;
  t: T;
  lang: string;
  open: (id: string) => void;
  record?: () => void;
  startInline?: (action?: Word) => void;
}

function createChild(props: SuggestionMenusProps, kind: "page" | "database") {
  const { book, t } = props;
  const page = book.add(
    kind === "database" ? t("newDb") : "",
    kind,
    props.entry.id,
  );

  insertPageLink(props.editor, book, t, page.id);
  props.open(page.id);
}

function aiItems({ t, startInline }: SuggestionMenusProps) {
  if (!startInline) return [];

  return [
    {
      title: t("askAiShort"),
      group: t("ai"),
      icon: <Sparkles size={ICON_SIZE} />,
      aliases: ["ai", "ki", "ask", "fragen"],
      onItemClick: () => startInline(),
    },
    {
      title: t("continueText"),
      group: t("ai"),
      icon: <PenLine size={ICON_SIZE} />,
      aliases: ["ai", "ki", "continue", "weiter"],
      onItemClick: () => startInline("continueText"),
    },
  ];
}

function recordItems({ t, record }: SuggestionMenusProps) {
  if (!record) return [];

  return [
    {
      title: t("audioNote"),
      subtext: t("audioNoteHint"),
      group: t("workspace"),
      icon: <Mic size={ICON_SIZE} />,
      aliases: AUDIO_ALIASES,
      onItemClick: record,
    },
  ];
}

function workspaceItems(props: SuggestionMenusProps) {
  const { editor, t } = props;

  return [
    {
      title: t("note"),
      group: t("workspace"),
      icon: <Lightbulb size={ICON_SIZE} />,
      aliases: ["callout", "hinweis", "note"],
      onItemClick: () =>
        editor.insertBlocks(
          [{ type: "quote", content: "💡 " }],
          editor.getTextCursorPosition().block,
          "after",
        ),
    },
    {
      title: t("child"),
      group: t("workspace"),
      icon: <FileText size={ICON_SIZE} />,
      aliases: ["page", "seite", "unterseite"],
      onItemClick: () => createChild(props, "page"),
    },
    {
      title: t("newDb"),
      group: t("workspace"),
      icon: <Table2 size={ICON_SIZE} />,
      aliases: ["database", "datenbank", "table", "tabelle"],
      onItemClick: () => createChild(props, "database"),
    },
  ];
}

function slashItems(props: SuggestionMenusProps, query: string) {
  return filterSuggestionItems(
    [
      ...aiItems(props),
      ...getDefaultReactSlashMenuItems(props.editor),
      ...recordItems(props),
      ...workspaceItems(props),
    ],
    query,
  );
}

export function SuggestionMenus(props: SuggestionMenusProps) {
  const { editor, book, t } = props;
  const mentions = (query: string) => pageSuggestions(editor, book, t, query);
  const today = {
    title: t("date"),
    onItemClick: () =>
      editor.insertInlineContent(new Date().toLocaleDateString(props.lang)),
  };

  return (
    <>
      <SuggestionMenuController
        triggerCharacter="/"
        getItems={async (query) => slashItems(props, query)}
      />
      <SuggestionMenuController
        triggerCharacter="@"
        getItems={async (query) => [...mentions(query), today]}
      />
      <SuggestionMenuController
        triggerCharacter="[["
        getItems={async (query) => mentions(query)}
      />
    </>
  );
}

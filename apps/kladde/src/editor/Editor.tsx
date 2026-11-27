import { useRef, type MouseEvent, type ReactNode } from "react";
import { useEditorState } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { BlockNoteEditor } from "@blocknote/core";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Policy } from "../ai/assistant";
import type { Reveal } from "../search/reveal";
import { aiExcluded } from "../ai/aiPages";
import { keepBefore } from "../versions/versions";
import { FileViewer } from "../viewer/FileViewer";
import { InlineAi } from "../inlineAi/InlineAi";
import { KeyboardBar } from "./KeyboardBar";
import {
  storePlainText,
  useNotebookEditor,
  useRegisteredEditor,
} from "./useNotebookEditor";
import { useReveal } from "./useReveal";
import { useBlockSelection } from "./useBlockSelection";
import { useFileViewer } from "./useFileViewer";
import { useEditorDrop } from "./useEditorDrop";
import { useInlineAiStart } from "./useInlineAiStart";
import { useKeyboardReveal } from "./useKeyboardReveal";
import { handleEditorKey } from "./editorKeys";
import { SuggestionMenus } from "./SuggestionMenus";
import { FormattingBar } from "./FormattingBar";
import { LinkBar } from "./LinkBar";
import { BlockedImages } from "./BlockedImages";
import { SelectionMarks } from "./SelectionMarks";
import { openLink } from "./openLink";
import { setPageLinkContext } from "./pageLinkSpec";

const EDITOR_LINK = ".bn-editor a[href]";
const LINK_TEXT = '[data-inline-content-type="link"]';
const MIDDLE_BUTTON = 1;

export interface EditorProps {
  entry: Entry;
  book: Notebook;
  lang: string;
  t: T;
  open: (id: string, inNewTab?: boolean) => void;
  register: (editor: BlockNoteEditor | null) => void;
  mobile: boolean;
  dark: boolean;
  ai: Policy;
  setupAi: () => void;
  notify: (text: string) => void;
  record?: () => void;
  after?: ReactNode;
  reveal?: Reveal;
  revealed?: () => void;
}

function focusEnd(editor: BlockNoteEditor, event: MouseEvent<HTMLElement>) {
  if (event.target !== event.currentTarget) return;
  const last = editor.document[editor.document.length - 1];

  if (last) editor.setTextCursorPosition(last, "end");
  editor.focus();
}

function selectingLinkText(target: Element) {
  return !!target.closest(LINK_TEXT) && !document.getSelection()?.isCollapsed;
}

function followLink(
  props: EditorProps,
  event: MouseEvent<HTMLElement>,
  inNewTab: boolean,
) {
  const target = event.target as Element;
  const href = target.closest(EDITOR_LINK)?.getAttribute("href");

  if (!href) return;
  event.preventDefault();
  if (event.shiftKey || selectingLinkText(target)) return;
  openLink(props, href, inNewTab);
}

export function Editor(props: EditorProps) {
  const { entry, book, t, mobile, ai, notify } = props;
  const section = useRef<HTMLElement>(null);
  const excluded = aiExcluded(book, entry.id);
  const { editor, files } = useNotebookEditor({
    ...props,
    aiEnabled: ai.enabled,
    excluded,
  });
  const viewer = useFileViewer({ ...props, editor });

  setPageLinkContext(editor, { book, t, open: props.open, notify });
  useReveal({ ...props, editor, section, view: viewer.setViewing });
  const selection = useBlockSelection(editor, section, !mobile);
  const marking = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      !current.prosemirrorState.selection.empty,
  });

  useRegisteredEditor(editor, files, props.register);
  useKeyboardReveal(editor, mobile);
  const drop = useEditorDrop({ editor, book, entry, section });
  const inline = useInlineAiStart({ editor, section, excluded, t, notify });
  const askAi = ai.enabled ? () => inline.start() : undefined;

  return (
    <section
      className="writing"
      data-formatting={(mobile && marking) || undefined}
      ref={section}
      onKeyDownCapture={(event) =>
        handleEditorKey(event, {
          editor,
          mobile,
          inlineOpen: !!inline.inline,
          aiReady: ai.enabled && !excluded,
          pickBlocks: selection.pick,
          startInline: askAi,
        })
      }
      onClick={(event) => focusEnd(editor, event)}
      onClickCapture={(event) =>
        followLink(props, event, event.metaKey || event.ctrlKey)
      }
      onAuxClickCapture={(event) => {
        if (event.button === MIDDLE_BUTTON) followLink(props, event, true);
      }}
      onDoubleClick={viewer.viewImage}
      onDragOver={drop.dragOver}
      onDragLeave={drop.dragLeave}
      onDropCapture={drop.dropPage}
      onDrop={drop.dropFiles}
    >
      <BlockNoteView
        editor={editor}
        theme={props.dark ? "dark" : "light"}
        slashMenu={false}
        formattingToolbar={false}
        linkToolbar={false}
        sideMenu={!mobile}
        onChange={() => storePlainText(editor, entry)}
      >
        {(!mobile || marking) && <FormattingBar t={t} askAi={askAi} />}
        <LinkBar />
        <SuggestionMenus
          {...props}
          editor={editor}
          startInline={ai.enabled ? inline.start : undefined}
        />
      </BlockNoteView>
      {props.after}
      {drop.dropSpot && (
        <div className="dropline" style={{ top: drop.dropSpot.line }} />
      )}
      <SelectionMarks selection={selection} />
      <BlockedImages editor={editor} book={book} entry={entry} t={t} />
      {viewer.viewer && <FileViewer {...viewer.viewer} />}
      {ai.enabled && inline.inline && !excluded && (
        <InlineAi
          key={inline.opening}
          editor={editor}
          policy={ai}
          space={book.id}
          start={inline.inline}
          t={t}
          close={inline.close}
          setup={() => {
            inline.dismiss();
            props.setupAi();
          }}
          keep={() => keepBefore(book, entry, "ai")}
        />
      )}
      {mobile && (
        <KeyboardBar editor={editor} t={t} record={props.record} ai={askAi} />
      )}
    </section>
  );
}

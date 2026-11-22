import {
  useRef,
  type ChangeEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { useEditorState } from "@blocknote/react";
import { SuggestionMenu } from "@blocknote/core/extensions";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  Bold,
  Heading2,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  KeyboardOff,
  List,
  ListTodo,
  Mic,
  Redo2,
  Slash,
  Sparkles,
  Undo2,
} from "lucide-react";
import type { T } from "../locale/locale";
import { insertFileAtCursor } from "./fileBlocks";

const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";
const HEADING_LEVEL = 2;

type LineType = "heading" | "checkListItem" | "bulletListItem";

const LINE_TOOLS = [
  { type: "heading", word: "heading", Icon: Heading2 },
  { type: "checkListItem", word: "todo", Icon: ListTodo },
  { type: "bulletListItem", word: "bulletList", Icon: List },
] as const;

interface Cursor {
  type: string;
  level: number;
  bold: boolean;
}

function keepFocus(event: SyntheticEvent) {
  event.preventDefault();
}

function readCursor(editor: BlockNoteEditor): Cursor {
  const block = editor.getTextCursorPosition().block;
  const props = block.props as { level?: number };

  return {
    type: block.type,
    level: props.level ?? 0,
    bold: !!editor.getActiveStyles().bold,
  };
}

function sameCursor(next: Cursor, previous: Cursor | null) {
  return (
    !!previous &&
    next.type === previous.type &&
    next.level === previous.level &&
    next.bold === previous.bold
  );
}

function isLine(cursor: Cursor, type: LineType) {
  if (type !== "heading") return cursor.type === type;

  return cursor.type === type && cursor.level === HEADING_LEVEL;
}

function Tool({
  label,
  pressed,
  run,
  children,
}: {
  label: string;
  pressed?: boolean;
  run: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={run}
    >
      {children}
    </button>
  );
}

interface ToolProps {
  editor: BlockNoteEditor;
  cursor: Cursor;
  t: T;
}

function toggleLine(editor: BlockNoteEditor, cursor: Cursor, type: LineType) {
  const block = editor.getTextCursorPosition().block;

  if (isLine(cursor, type)) editor.updateBlock(block, { type: "paragraph" });
  else if (type === "heading")
    editor.updateBlock(block, { type, props: { level: HEADING_LEVEL } });
  else editor.updateBlock(block, { type });
}

function openCommands(editor: BlockNoteEditor) {
  const menu = editor.getExtension(SuggestionMenu);

  if (menu) menu.openSuggestionMenu("/", { deleteTriggerCharacter: true });
  else editor.insertInlineContent("/");
}

function hideKeyboard() {
  (document.activeElement as HTMLElement | null)?.blur();
}

function insertPicked(
  editor: BlockNoteEditor,
  event: ChangeEvent<HTMLInputElement>,
) {
  const file = event.target.files?.[0];

  event.target.value = "";
  if (file) void insertFileAtCursor(editor, file);
}

function FormatTools({ editor, cursor, t }: ToolProps) {
  return (
    <>
      {LINE_TOOLS.map(({ type, word, Icon }) => (
        <Tool
          key={type}
          label={t(word)}
          pressed={isLine(cursor, type)}
          run={() => toggleLine(editor, cursor, type)}
        >
          <Icon />
        </Tool>
      ))}
      <Tool
        label={t("bold")}
        pressed={cursor.bold}
        run={() => editor.toggleStyles({ bold: true })}
      >
        <Bold />
      </Tool>
    </>
  );
}

function KeyboardTools({
  editor,
  cursor,
  t,
  record,
  ai,
  pickImage,
}: ToolProps & {
  record?: () => void;
  ai?: () => void;
  pickImage: () => void;
}) {
  return (
    <div className="keyboardtools">
      {record && (
        <Tool label={t("audioNote")} run={record}>
          <Mic />
        </Tool>
      )}
      <Tool label={t("commands")} run={() => openCommands(editor)}>
        <Slash />
      </Tool>
      {ai && (
        <Tool label={t("ai")} run={ai}>
          <Sparkles className="aimark" />
        </Tool>
      )}
      <FormatTools editor={editor} cursor={cursor} t={t} />
      <Tool label={t("outdent")} run={() => editor.unnestBlock()}>
        <IndentDecrease />
      </Tool>
      <Tool label={t("indent")} run={() => editor.nestBlock()}>
        <IndentIncrease />
      </Tool>
      <Tool label={t("image")} run={pickImage}>
        <ImagePlus />
      </Tool>
      <Tool label={t("redo")} run={() => editor.redo()}>
        <Redo2 />
      </Tool>
    </div>
  );
}

export function KeyboardBar({
  editor,
  t,
  record,
  ai,
}: {
  editor: BlockNoteEditor;
  t: T;
  record?: () => void;
  ai?: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const cursor = useEditorState({
    editor,
    selector: ({ editor: current }) => readCursor(current),
    equalityFn: sameCursor,
  });

  return (
    <>
      <div className="keyboardbar" role="toolbar" aria-label={t("formatting")}>
        <KeyboardTools
          editor={editor}
          cursor={cursor}
          t={t}
          record={record}
          ai={ai}
          pickImage={() => picker.current?.click()}
        />
        <div className="keyboardfixed">
          <Tool label={t("undo")} run={() => editor.undo()}>
            <Undo2 />
          </Tool>
          <Tool label={t("hideKeyboard")} run={hideKeyboard}>
            <KeyboardOff />
          </Tool>
        </div>
      </div>
      <input
        ref={picker}
        type="file"
        accept={IMAGE_TYPES}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => insertPicked(editor, event)}
      />
    </>
  );
}

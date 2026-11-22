import {
  createFileBlockConfig,
  fileParse,
  type BlockNoteEditor,
} from "@blocknote/core";
import {
  FileBlockWrapper,
  createReactBlockSpec,
  useBlockNoteEditor,
  useComponentsContext,
  useEditorState,
} from "@blocknote/react";
import {
  Captions,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Maximize2,
  PenLine,
} from "lucide-react";
import { useState } from "react";
import { downloadFile, isPdf } from "../files/attachments";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { isLocalFile, type ViewTarget } from "../viewer/viewing";
import { usePdfPreview, type PdfPreview } from "./usePdfPreview";

interface FileContext {
  book: Notebook;
  entry: Entry;
  t: T;
  transcribe?: (block: string, url: string, name: string) => void;
  view?: (target: ViewTarget) => void;
}

const contexts = new WeakMap<object, FileContext>();

export function setFileContext(editor: object, context: FileContext) {
  contexts.set(editor, context);
}

interface PdfProps {
  block: string;
  url: string;
  name: string;
  context: FileContext;
}

type Open = (edit: boolean) => void;

function PdfPager({
  index,
  pages,
  setIndex,
  t,
}: {
  index: number;
  pages: number;
  setIndex: (index: number) => void;
  t: T;
}) {
  return (
    <span className="pdfpager">
      <button
        type="button"
        title={t("previous")}
        aria-label={t("previous")}
        disabled={index === 0}
        onClick={() => setIndex(index - 1)}
      >
        <ChevronLeft size={16} />
      </button>
      <span>
        {index + 1} / {pages}
      </span>
      <button
        type="button"
        title={t("next")}
        aria-label={t("next")}
        disabled={index + 1 >= pages}
        onClick={() => setIndex(index + 1)}
      >
        <ChevronRight size={16} />
      </button>
    </span>
  );
}

function PdfViewButtons({ open, t }: { open: Open; t: T }) {
  return (
    <>
      <button
        type="button"
        title={t("editFile")}
        aria-label={t("editFile")}
        onClick={() => open(true)}
      >
        <PenLine size={16} />
      </button>
      <button
        type="button"
        title={t("open")}
        aria-label={t("open")}
        onClick={() => open(false)}
      >
        <Maximize2 size={16} />
      </button>
    </>
  );
}

function PdfPage({
  preview,
  error,
  label,
  opens,
  open,
  t,
}: {
  preview: PdfPreview | null | undefined;
  error: string;
  label: string;
  opens: boolean;
  open: Open;
  t: T;
}) {
  if (!preview)
    return (
      <p role="status">
        {error || t(preview === undefined ? "previewLoading" : "noFilePreview")}
      </p>
    );

  return (
    <img
      className="pdfpage"
      src={"data:image/jpeg;base64," + preview[1]}
      alt={label}
      draggable={false}
      data-opens={opens ? "" : undefined}
      onClick={() => open(false)}
    />
  );
}

function PdfBlock({ block, url, name, context }: PdfProps) {
  const { book, entry, t, view } = context;
  const [index, setIndex] = useState(0);
  const { preview, error } = usePdfPreview(book, entry, url, index);
  const label = name || t("file");
  const open = (edit: boolean) =>
    view?.({ block, url, name, kind: "pdf", page: index, edit });

  return (
    <div className="pdfblock" contentEditable={false}>
      <div className="pdfbar">
        <FileText size={16} />
        <span className="pdfname">{label}</span>
        {preview && preview[0] > 1 && (
          <PdfPager
            index={index}
            pages={preview[0]}
            setIndex={setIndex}
            t={t}
          />
        )}
        {view && <PdfViewButtons open={open} t={t} />}
        <button
          type="button"
          className="pdfdownload"
          title={t("downloadFile")}
          aria-label={t("downloadFile")}
          onClick={() => downloadFile(book, entry, url, name).catch(() => {})}
        >
          <Download size={16} />
        </button>
      </div>
      <PdfPage
        preview={preview}
        error={error}
        label={label}
        opens={!!view}
        open={open}
        t={t}
      />
    </div>
  );
}

type FileBlockProps = Parameters<typeof FileBlockWrapper>[0];

function FileBlockView(props: FileBlockProps) {
  const editor = useBlockNoteEditor();
  const context = contexts.get(editor);
  const { url, name } = props.block.props;

  if (context && url && isPdf(context.entry, url, name))
    return (
      <PdfBlock
        block={props.block.id}
        url={url}
        name={name}
        context={context}
      />
    );

  return <FileBlockWrapper {...props} />;
}

export const fileBlock = createReactBlockSpec(createFileBlockConfig, {
  render: (props) => <FileBlockView {...props} />,
  parse: fileParse(),
  toExternalHTML: (props) =>
    props.block.props.url ? (
      <a href={props.block.props.url}>
        {props.block.props.name || props.block.props.url}
      </a>
    ) : (
      <p />
    ),
});

export function DownloadFileButton() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const context = contexts.get(editor);
  const block = useEditorState({
    editor,
    selector: ({ editor }: { editor: BlockNoteEditor }) => {
      const selected = editor.getSelection()?.blocks ?? [
        editor.getTextCursorPosition().block,
      ];

      if (selected.length !== 1) return undefined;
      const only = selected[0];
      const props = only.props as { url?: unknown; name?: unknown };

      if (typeof props.url !== "string" || !props.url) return undefined;

      return { url: props.url, name: String(props.name ?? "") };
    },
  });

  if (!context || !block) return null;
  const label = context.t("downloadFile");

  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label={label}
      mainTooltip={label}
      icon={<Download size={16} />}
      onClick={() =>
        downloadFile(context.book, context.entry, block.url, block.name).catch(
          () => {},
        )
      }
    />
  );
}

export function viewTargetOf(
  entry: Entry,
  block: { id: string; type: string; props: unknown },
): ViewTarget | undefined {
  const props = block.props as { url?: unknown; name?: unknown };

  if (typeof props.url !== "string" || !isLocalFile(props.url))
    return undefined;
  const name = String(props.name ?? "");

  if (block.type === "image")
    return { block: block.id, url: props.url, name, kind: "image" };
  if (block.type === "file" && isPdf(entry, props.url, name))
    return { block: block.id, url: props.url, name, kind: "pdf" };

  return undefined;
}

function viewable(editor: BlockNoteEditor): ViewTarget | undefined {
  const context = contexts.get(editor);
  const selected = editor.getSelection()?.blocks ?? [
    editor.getTextCursorPosition().block,
  ];

  if (!context || selected.length !== 1) return undefined;

  return viewTargetOf(context.entry, selected[0]);
}

export function ViewFileButton() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const context = contexts.get(editor);
  const target = useEditorState({
    editor,
    selector: ({ editor }: { editor: BlockNoteEditor }) => viewable(editor),
  });
  const view = context?.view;

  if (!context || !view || !target) return null;
  const label = context.t("open");

  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label={label}
      mainTooltip={label}
      icon={<Maximize2 size={16} />}
      onClick={() => view(target)}
    />
  );
}

export function TranscribeButton() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const context = contexts.get(editor);
  const block = useEditorState({
    editor,
    selector: ({ editor }: { editor: BlockNoteEditor }) => {
      const selected = editor.getSelection()?.blocks ?? [
        editor.getTextCursorPosition().block,
      ];

      if (selected.length !== 1 || selected[0].type !== "audio")
        return undefined;
      const props = selected[0].props as { url?: unknown; name?: unknown };

      if (
        typeof props.url !== "string" ||
        !props.url.startsWith("kladde-file:")
      )
        return undefined;

      return {
        id: selected[0].id,
        url: props.url,
        name: String(props.name ?? ""),
      };
    },
  });
  const transcribe = context?.transcribe;

  if (!context || !transcribe || !block) return null;
  const label = context.t("transcribe");

  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label={label}
      mainTooltip={label}
      icon={<Captions size={16} />}
      onClick={() => transcribe(block.id, block.url, block.name)}
    />
  );
}

import {
  ArchiveRestore,
  CornerUpRight,
  FileArchive,
  FileUp,
  FolderInput,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import type { Notebook } from "../notebook/notebook";
import { importExtensions } from "./importFiles";
import type { T } from "../locale/locale";
import type { Ask } from "../ui/dialog";
import { Select } from "../ui/Select";
import { NotionImportPanel } from "../notionImport/NotionImportPanel";
import { ActionRow, FileAction } from "../ui/ActionRow";
import { BACKUP_SUFFIX, useTransfer } from "./useTransfer";

type TransferState = ReturnType<typeof useTransfer>;

interface SectionProps {
  transfer: TransferState;
  t: T;
  mobile: boolean;
}

interface MoveSectionProps {
  book: Notebook;
  books: [string, string][];
  transfer: TransferState;
  t: T;
}

const NO_CHOICE = { value: "", label: "—" };

function TransferStatus({ transfer }: { transfer: TransferState }) {
  if (!transfer.message) return null;

  return (
    <p className="transferstatus" role="status" aria-live="polite">
      {transfer.busy && <LoaderCircle className="spin" aria-hidden="true" />}
      {transfer.message}
    </p>
  );
}

function ImportSection({ transfer, t, mobile }: SectionProps) {
  return (
    <section>
      <h3>{t("import")}</h3>
      <p className="muted">{t("importInfo")}</p>
      <FileAction
        icon={FileUp}
        label={t("importFilesAction")}
        hint={t("importFilesHint")}
        accept={mobile ? undefined : importExtensions}
        multiple
        disabled={transfer.busy}
        pick={(list) => void transfer.importList(list)}
      />
      {!mobile && (
        <FileAction
          icon={FolderInput}
          label={t("importFolder")}
          hint={t("importFolderHint")}
          folder
          disabled={transfer.busy}
          pick={(list) => void transfer.importList(list)}
        />
      )}
    </section>
  );
}

function ExportSection({ transfer, t, mobile }: SectionProps) {
  return (
    <section>
      <h3>{t("exportSection")}</h3>
      <ActionRow
        icon={FileArchive}
        label={t("exportBook")}
        hint={t("exportZipHint")}
        disabled={transfer.busy}
        run={() => void transfer.exportAll()}
      />
      <ActionRow
        icon={ShieldCheck}
        label={t("backup")}
        hint={t("backupHint")}
        disabled={transfer.busy}
        run={() => void transfer.backup()}
      />
      <FileAction
        icon={ArchiveRestore}
        label={t("restoreBackup")}
        hint={t("restoreHint")}
        accept={mobile ? undefined : BACKUP_SUFFIX}
        disabled={transfer.busy}
        pick={(list) => void transfer.restore(list)}
      />
    </section>
  );
}

function pageChoices(book: Notebook, t: T) {
  return [
    NO_CHOICE,
    ...[...book.pages.values()]
      .filter(
        (page) => !page.archived && page.kind !== "chat" && page.kind !== "row",
      )
      .map((page) => ({ value: page.id, label: page.title || t("untitled") })),
  ];
}

function bookChoices(book: Notebook, books: [string, string][]) {
  return [
    NO_CHOICE,
    ...books
      .filter(([id]) => id !== book.id)
      .map(([id, name]) => ({ value: id, label: name })),
  ];
}

function MoveSection({ book, books, transfer, t }: MoveSectionProps) {
  return (
    <section>
      <h3>{t("moveBook")}</h3>
      <p className="muted">{t("moveBookHint")}</p>
      <div className="transfermove">
        <Select
          label={t("pages")}
          searchLabel={t("searchPages")}
          value={transfer.pageId}
          choices={pageChoices(book, t)}
          change={transfer.setPageId}
        />
        <Select
          label={t("workspace")}
          value={transfer.target}
          choices={bookChoices(book, books)}
          change={transfer.setTarget}
        />
        <ActionRow
          icon={CornerUpRight}
          label={t("move")}
          disabled={transfer.busy || !transfer.pageId || !transfer.target}
          run={() => void transfer.move()}
        />
      </div>
    </section>
  );
}

export function Transfer({
  book,
  t,
  ask,
  open,
  books,
  mobile,
}: {
  book: Notebook;
  t: T;
  ask: Ask;
  open: (id: string) => void;
  books: [string, string][];
  mobile: boolean;
}) {
  const transfer = useTransfer({ book, t, ask, open });

  return (
    <div className="transfer">
      <TransferStatus transfer={transfer} />
      <ImportSection transfer={transfer} t={t} mobile={mobile} />
      <NotionImportPanel book={book} t={t} open={open} mobile={mobile} />
      <ExportSection transfer={transfer} t={t} mobile={mobile} />
      {books.length > 1 && (
        <MoveSection book={book} books={books} transfer={transfer} t={t} />
      )}
    </div>
  );
}

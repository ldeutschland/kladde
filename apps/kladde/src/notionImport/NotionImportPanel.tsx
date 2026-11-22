import { FileArchive, FolderInput } from "lucide-react";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { FileAction } from "../ui/ActionRow";
import { useNotionImport } from "./useNotionImport";

const SHOWN_SKIPPED = 200;

type NotionImport = ReturnType<typeof useNotionImport>;

function SkippedList({ skipped, t }: { skipped: string[]; t: T }) {
  return (
    <details className="notion-skipped">
      <summary>
        {t("notionSkipped")} {skipped.length}
      </summary>
      <ul>
        {skipped.slice(0, SHOWN_SKIPPED).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </details>
  );
}

function ImportActions({
  notion,
  t,
  mobile,
}: {
  notion: NotionImport;
  t: T;
  mobile: boolean;
}) {
  const { busy, remoteImages } = notion;

  return (
    <>
      <FileAction
        icon={FileArchive}
        label={t("notionZip")}
        hint={t("notionZipHint")}
        accept={mobile ? undefined : ".zip"}
        disabled={busy}
        pick={(list) => void notion.run(list)}
      />
      {!mobile && (
        <FileAction
          icon={FolderInput}
          label={t("notionFolder")}
          folder
          disabled={busy}
          pick={(list) => void notion.run(list)}
        />
      )}
      <button
        type="button"
        className="switchitem"
        aria-pressed={remoteImages}
        disabled={busy}
        onClick={() => notion.setRemoteImages(!remoteImages)}
      >
        <span className="grow">{t("notionRemoteImages")}</span>
        <span className="switch" />
      </button>
    </>
  );
}

export function NotionImportPanel({
  book,
  t,
  open,
  mobile,
}: {
  book: Notebook;
  t: T;
  open: (id: string) => void;
  mobile: boolean;
}) {
  const notion = useNotionImport(book, t);
  const { status, first, skipped } = notion;

  return (
    <section>
      <h3>{t("notionImport")}</h3>
      <p className="muted">{t("notionInfo")}</p>
      <ImportActions notion={notion} t={t} mobile={mobile} />
      {status && (
        <p className="transferstatus" role="status" aria-live="polite">
          {status}
        </p>
      )}
      {first && (
        <button className="primary" onClick={() => open(first)}>
          {t("open")}
        </button>
      )}
      {skipped.length > 0 && <SkippedList skipped={skipped} t={t} />}
    </section>
  );
}

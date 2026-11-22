import { Suspense } from "react";
import { Maximize2, X } from "lucide-react";
import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { Panel } from "../ui/dialog";
import { Editor, Properties } from "./lazyParts";
import { TitleField } from "./TitleField";
import type { EditorSetup } from "./PageView";
import type { Go, RowPeek as Peek } from "./types";

function ignoreEditor() {}

export function RowPeek({
  book,
  row,
  page,
  t,
  mobile,
  go,
  expand,
  setup,
  close,
}: {
  book: Notebook;
  row: NonNullable<Peek>;
  page: Page;
  t: T;
  mobile: boolean;
  go: Go;
  expand: () => void;
  setup: Omit<EditorSetup, "record">;
  close: () => void;
}) {
  return (
    <Panel
      bare
      title={page.title || t("untitled")}
      t={t}
      close={close}
      className="peek"
    >
      <div className="peekbar">
        <button onClick={expand}>
          <Maximize2 />
          {t("sheet")}
        </button>
        {mobile ? (
          <button className="peekdone" onClick={close}>
            {t("done")}
          </button>
        ) : (
          <button aria-label={t("close")} onClick={close}>
            <X />
          </button>
        )}
      </div>
      <div className="peekbody">
        <TitleField
          value={page.title}
          label={t("title")}
          placeholder={t("untitled")}
          change={(title) => void book.change(page.id, { title })}
        />
        <Suspense fallback={null}>
          <Properties book={book} entry={row.entry} db={row.db} t={t} />
          <Editor
            book={book}
            entry={row.entry}
            lang={setup.lang}
            t={t}
            mobile={mobile}
            dark={setup.dark}
            open={go}
            register={ignoreEditor}
            ai={setup.ai}
            setupAi={setup.setupAi}
            notify={setup.notify}
            reveal={
              setup.reveal?.page === row.entry.id ? setup.reveal : undefined
            }
            revealed={setup.revealed}
          />
        </Suspense>
      </div>
    </Panel>
  );
}

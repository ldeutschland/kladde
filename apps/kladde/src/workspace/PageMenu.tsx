import {
  ALargeSmall,
  AppWindow,
  Brain,
  Copy,
  CornerUpRight,
  Download,
  EyeOff,
  FilePlus,
  History,
  Mic,
  MoveHorizontal,
  Pencil,
  Star,
  Table2,
  Trash2,
} from "lucide-react";
import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { Popover, listKeys } from "../ui/dialog";
import { ROLE_LABELS, exclusionSource, pageRole } from "../ai/aiPages";
import { useAiOn } from "../ai/aiSwitch";
import { since } from "./since";

export interface PageMenuActions {
  openTab: (target: string) => void;
  duplicate: (target: string) => void;
  chooseRole: () => void;
  rename: (page: Page) => void;
  move: (target: string) => void;
  create: (kind: "page" | "database", parent: string) => void;
  record: () => void;
  history: (target: string) => void;
  export: (page: Page) => void;
  trash: (page: Page) => void;
}

function LayoutSwitches({
  book,
  page,
  t,
}: {
  book: Notebook;
  page: Page;
  t: T;
}) {
  const small = !!book.settings.get("small");

  return (
    <>
      <button
        className="switchitem"
        aria-pressed={page.wide}
        onClick={() => book.change(page.id, { wide: !page.wide })}
      >
        <MoveHorizontal />
        {t("wide")}
        <span className="switch" />
      </button>
      <button
        className="switchitem"
        aria-pressed={small}
        onClick={() => book.settings.set("small", !small)}
      >
        <ALargeSmall />
        {t("small")}
        <span className="switch" />
      </button>
      <hr />
    </>
  );
}

function AiItems({
  book,
  page,
  t,
  chooseRole,
}: {
  book: Notebook;
  page: Page;
  t: T;
  chooseRole: () => void;
}) {
  const aiOn = useAiOn();
  const role = pageRole(book, page);
  const exclusion = exclusionSource(book.pages, page.id);
  const inherited = !!exclusion && exclusion.id !== page.id;

  if (!aiOn) return null;

  return (
    <>
      {(page.kind === "page" || page.kind === "row") && (
        <button onClick={chooseRole}>
          <Brain />
          <span className="grow">{t("aiUseAs")}</span>
          {role && <small>{t(ROLE_LABELS[role])}</small>}
        </button>
      )}
      <button
        className="switchitem"
        aria-pressed={!!exclusion}
        disabled={inherited}
        onClick={() =>
          void book.change(page.id, { aiExcluded: !page.aiExcluded })
        }
      >
        <EyeOff />
        {t("aiExclude")}
        <span className="switch" />
      </button>
      {inherited && (
        <p className="menunote">
          {t("aiExcludedVia")} „{exclusion?.title || t("untitled")}“
        </p>
      )}
    </>
  );
}

function CreateItems({
  page,
  t,
  create,
}: {
  page: Page;
  t: T;
  create: PageMenuActions["create"];
}) {
  return (
    <>
      <button onClick={() => create("page", page.id)}>
        <FilePlus />
        {t("child")}
      </button>
      <button onClick={() => create("database", page.id)}>
        <Table2 />
        {t("newDb")}
      </button>
    </>
  );
}

export function PageMenu({
  book,
  page,
  current,
  anchor,
  t,
  close,
  lang,
  mobile,
  actions,
}: {
  book: Notebook;
  page: Page;
  current: boolean;
  anchor: DOMRect;
  t: T;
  close: () => void;
  lang: string;
  mobile: boolean;
  actions: PageMenuActions;
}) {
  return (
    <Popover anchor={anchor} label={t("actions")} close={close}>
      <div className="menu" onKeyDown={listKeys}>
        {current && <LayoutSwitches book={book} page={page} t={t} />}
        <button
          onClick={() => {
            void book.change(page.id, { favorite: !page.favorite });
            close();
          }}
        >
          <Star />
          {page.favorite ? t("removeFavorite") : t("addFavorite")}
        </button>
        {!mobile && (
          <button onClick={() => actions.openTab(page.id)}>
            <AppWindow />
            {t("openInNewTab")}
          </button>
        )}
        <button onClick={() => actions.duplicate(page.id)}>
          <Copy />
          {t("duplicate")}
        </button>
        <AiItems
          book={book}
          page={page}
          t={t}
          chooseRole={actions.chooseRole}
        />
        <button onClick={() => actions.rename(page)}>
          <Pencil />
          {t("rename")}
        </button>
        {page.kind !== "row" && (
          <button onClick={() => actions.move(page.id)}>
            <CornerUpRight />
            {t("moveTo")}
          </button>
        )}
        {page.kind === "page" && (
          <CreateItems page={page} t={t} create={actions.create} />
        )}
        {current && page.kind !== "database" && (
          <button onClick={actions.record}>
            <Mic />
            {t("audioNote")}
          </button>
        )}
        {current && (
          <button onClick={() => actions.history(page.id)}>
            <History />
            {t("history")}
          </button>
        )}
        <button onClick={() => actions.export(page)}>
          <Download />
          {t("export")}
        </button>
        <hr />
        <button className="danger" onClick={() => actions.trash(page)}>
          <Trash2 />
          {t("toTrash")}
        </button>
        <footer>
          {t("editedAt")} {since(book.editedAt(page), lang, t)}
        </footer>
      </div>
    </Popover>
  );
}

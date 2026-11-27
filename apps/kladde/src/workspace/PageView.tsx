import {
  Suspense,
  useEffect,
  useState,
  type ComponentProps,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ImagePlus, SmilePlus } from "lucide-react";
import type { Entry, Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { RootTab } from "../platform/chrome";
import type { Policy } from "../ai/assistant";
import type { Reveal } from "../search/reveal";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { PageImage } from "./PageImage";
import { PageIcon } from "./tree";
import { pagesLinkedIn } from "../notebook/links";
import { comparePages, pageSort } from "../notebook/pageSort";
import { appendFiles } from "../editor/fileBlocks";
import { allowDrop, carriesFiles, droppedFiles } from "../ui/dragDrop";
import { viewKey } from "./viewMemory";
import { COVER_TONES, STARTER_ICONS, pick } from "./commands";
import { Database, Editor, Properties } from "./lazyParts";
import { PageButton } from "./PageButton";
import { TitleField } from "./TitleField";
import type { ActiveEditor } from "./useActiveEditor";
import type { PageDrops } from "./usePageDrops";
import type { PageLink } from "./types";

const FILE_PREFIX = "kladde-file:";

type DatabaseProps = Omit<ComponentProps<typeof Database>, "db" | "book">;
type ShowMenu = (
  kind: "icon" | "cover",
  target: string,
  e: MouseEvent<HTMLElement>,
) => void;

export interface EditorSetup {
  lang: string;
  dark: boolean;
  ai: Policy;
  setupAi: () => void;
  notify: (text: string) => void;
  reveal: Reveal | null;
  revealed: () => void;
  record: () => void;
}

function ChildPages({
  book,
  entry,
  render,
}: {
  book: Notebook;
  entry: Entry;
  render: (page: Page) => ReactNode;
}) {
  const linked = new Set(
    pagesLinkedIn(String(entry.doc.getMap("meta").get("text") ?? "")),
  );
  const children = Array.from(book.pages.values())
    .filter(
      (p) =>
        p.parent === entry.id &&
        p.kind === "page" &&
        !p.archived &&
        !linked.has(p.id),
    )
    .sort(comparePages(book, pageSort(book)));

  if (!children.length) return null;

  return <nav className="subpages">{children.map(render)}</nav>;
}

function ViewFailed({ t }: { t: T }) {
  return (
    <div className="emptystate">
      <p>{t("viewFailed")}</p>
    </div>
  );
}

function InlineDb({
  id,
  book,
  openPage,
  ...props
}: DatabaseProps & {
  id: string;
  book: Notebook;
  openPage: (id: string) => void;
}) {
  const [db, set] = useState<Entry | null>(null);

  useEffect(() => {
    void book.load(id).then(set);
  }, [book, id]);
  if (!db) return null;
  const page = book.pages.get(db.id);

  return (
    <section className="inlinedb">
      <button className="inlinetitle" onClick={() => openPage(db.id)}>
        {page && <PageIcon page={page} />}
        {page?.title || props.t("untitled")}
      </button>
      <ErrorBoundary key={db.id} fallback={<ViewFailed t={props.t} />}>
        <Database {...props} book={book} db={db} />
      </ErrorBoundary>
    </section>
  );
}

function PageCover({
  book,
  entry,
  page,
  t,
  toolsShown,
  toggleTools,
  drops,
  showMenu,
}: {
  book: Notebook;
  entry: Entry;
  page: Page;
  t: T;
  toolsShown: boolean;
  toggleTools: () => void;
  drops: PageDrops;
  showMenu: ShowMenu;
}) {
  return (
    <div
      className="cover"
      data-tone={page.cover}
      data-tools={toolsShown || undefined}
      onClick={(e) => {
        if ((e.target as Element).closest("button")) return;
        toggleTools();
      }}
      {...drops.image("cover", page.id)}
    >
      {page.cover.startsWith(FILE_PREFIX) && (
        <PageImage book={book} entry={entry} reference={page.cover} cover />
      )}
      <div className="covertools">
        <button onClick={(e) => showMenu("cover", page.id, e)}>
          {t("changeCover")}
        </button>
        <button onClick={() => book.change(page.id, { cover: "" })}>
          {t("remove")}
        </button>
      </div>
    </div>
  );
}

function PageControls({
  book,
  page,
  t,
  mobile,
  drops,
}: {
  book: Notebook;
  page: Page;
  t: T;
  mobile: boolean;
  drops: PageDrops;
}) {
  return (
    <div className="pagecontrols">
      {!page.icon && (
        <button
          {...drops.image("icon", page.id)}
          aria-label={t("addIcon")}
          onClick={() => book.change(page.id, { icon: pick(STARTER_ICONS) })}
        >
          <SmilePlus />
          {mobile ? t("icon") : t("addIcon")}
        </button>
      )}
      {!page.cover && (
        <button
          {...drops.image("cover", page.id)}
          aria-label={t("addCover")}
          onClick={() => book.change(page.id, { cover: pick(COVER_TONES) })}
        >
          <ImagePlus />
          {mobile ? t("cover") : t("addCover")}
        </button>
      )}
    </div>
  );
}

function PageHead({
  book,
  entry,
  page,
  t,
  mobile,
  drops,
  showMenu,
  leaveTitle,
}: {
  book: Notebook;
  entry: Entry;
  page: Page;
  t: T;
  mobile: boolean;
  drops: PageDrops;
  showMenu: ShowMenu;
  leaveTitle: (split: boolean) => void;
}) {
  return (
    <div className="pagehead">
      {page.icon && (
        <button
          className="pageicon"
          aria-label={t("icon")}
          {...drops.image("icon", page.id)}
          onClick={(e) => showMenu("icon", page.id, e)}
        >
          {page.icon.startsWith(FILE_PREFIX) ? (
            <PageImage book={book} entry={entry} reference={page.icon} />
          ) : (
            page.icon
          )}
        </button>
      )}
      <PageControls
        book={book}
        page={page}
        t={t}
        mobile={mobile}
        drops={drops}
      />
      <TitleField
        value={page.title}
        label={t("title")}
        placeholder={t("untitled")}
        change={(title) => void book.change(page.id, { title })}
        leave={page.kind === "database" ? undefined : leaveTitle}
      />
    </div>
  );
}

function PageContent({
  book,
  entry,
  page,
  all,
  database,
  link,
  editor,
  setup,
  dbProps,
  openPage,
}: {
  book: Notebook;
  entry: Entry;
  page: Page;
  all: Page[];
  database: Entry | null;
  link: PageLink;
  editor: ActiveEditor;
  setup: EditorSetup;
  dbProps: DatabaseProps;
  openPage: (id: string) => void;
}) {
  const { t, mobile } = dbProps;
  const inlineDbs = all.filter(
    (p) => p.parent === page.id && !p.archived && p.kind === "database",
  );

  return (
    <Suspense fallback={null}>
      {page.kind === "row" && database && (
        <Properties book={book} entry={entry} db={database} t={t} />
      )}
      {page.kind === "database" ? (
        <ErrorBoundary key={entry.id} fallback={<ViewFailed t={t} />}>
          <Database {...dbProps} db={entry} book={book} />
        </ErrorBoundary>
      ) : (
        <Editor
          book={book}
          entry={entry}
          lang={setup.lang}
          t={t}
          mobile={mobile}
          dark={setup.dark}
          open={link.go}
          register={editor.register}
          ai={setup.ai}
          setupAi={setup.setupAi}
          notify={setup.notify}
          record={setup.record}
          reveal={setup.reveal?.page === entry.id ? setup.reveal : undefined}
          revealed={setup.revealed}
          after={
            <ChildPages
              book={book}
              entry={entry}
              render={(p) => (
                <PageButton
                  key={p.id}
                  page={p}
                  link={link}
                  t={t}
                  className="subpage"
                />
              )}
            />
          }
        />
      )}
      {inlineDbs.map((p) => (
        <InlineDb
          key={p.id}
          id={p.id}
          book={book}
          openPage={openPage}
          {...dbProps}
        />
      ))}
    </Suspense>
  );
}

function Backlinks({
  book,
  links,
  link,
  t,
}: {
  book: Notebook;
  links: string[];
  link: PageLink;
  t: T;
}) {
  return (
    <section className="backlinks">
      <h3>{t("backlinks")}</h3>
      {links
        .map((k) => book.pages.get(k))
        .filter((p): p is Page => !!p && !p.archived)
        .map((p) => (
          <PageButton key={p.id} page={p} link={link} t={t} />
        ))}
    </section>
  );
}

function paperClass(page: Page) {
  return (
    "paper" +
    (page.cover ? " hascover" : "") +
    (page.icon ? " hasicon" : "") +
    (page.kind === "database" ? " isdb" : "")
  );
}

function fileDrops(editor: ActiveEditor) {
  return {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!carriesFiles(e) || !editor.editor.current) return;
      if ((e.target as Element).closest(".bn-editor")) return;
      allowDrop(e, "copy");
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const current = editor.editor.current;

      if (!carriesFiles(e) || !current || e.nativeEvent.defaultPrevented)
        return;
      e.preventDefault();
      void appendFiles(current, droppedFiles(e));
    },
  };
}

export function PageView({
  book,
  entry,
  page,
  all,
  database,
  backlinks,
  viewRef,
  tab,
  small,
  coverTools,
  toggleCoverTools,
  showMenu,
  link,
  drops,
  editor,
  setup,
  dbProps,
  openPage,
}: {
  book: Notebook;
  entry: Entry;
  page: Page;
  all: Page[];
  database: Entry | null;
  backlinks: string[];
  viewRef: RefObject<HTMLElement | null>;
  tab: RootTab;
  small: boolean;
  coverTools: boolean;
  toggleCoverTools: () => void;
  showMenu: ShowMenu;
  link: PageLink;
  drops: PageDrops;
  editor: ActiveEditor;
  setup: EditorSetup;
  dbProps: DatabaseProps;
  openPage: (id: string) => void;
}) {
  const { t, mobile } = dbProps;

  return (
    <article
      className={
        "document" + (page.wide ? " wide" : "") + (small ? " small" : "")
      }
      ref={viewRef}
      data-view={viewKey(page.id, tab)}
      {...fileDrops(editor)}
    >
      {page.cover && (
        <PageCover
          book={book}
          entry={entry}
          page={page}
          t={t}
          toolsShown={coverTools}
          toggleTools={toggleCoverTools}
          drops={drops}
          showMenu={showMenu}
        />
      )}
      <div className={paperClass(page)}>
        <PageHead
          book={book}
          entry={entry}
          page={page}
          t={t}
          mobile={mobile}
          drops={drops}
          showMenu={showMenu}
          leaveTitle={editor.leaveTitle}
        />
        <PageContent
          book={book}
          entry={entry}
          page={page}
          all={all}
          database={database}
          link={link}
          editor={editor}
          setup={setup}
          dbProps={dbProps}
          openPage={openPage}
        />
        {backlinks.length > 0 && (
          <Backlinks book={book} links={backlinks} link={link} t={t} />
        )}
      </div>
    </article>
  );
}

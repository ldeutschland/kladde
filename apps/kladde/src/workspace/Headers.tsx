import { Fragment, type MouseEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CloudAlert,
  House,
  Menu,
  MoreHorizontal,
  Settings,
  Star,
} from "lucide-react";
import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { PageIcon } from "./tree";
import { startPageDrag } from "../ui/dragDrop";
import { since } from "./since";
import { wantsNewTab } from "./PageButton";
import type { PageDrops } from "./usePageDrops";
import type { PageLink } from "./types";

const MAX_CRUMBS = 12;

export function saveState(book: Notebook, t: T) {
  if (book.error) return t("unsaved");

  return book.dirty.size || book.busy ? t("saving") : t("saved");
}

function crumbsOf(book: Notebook, page: Page) {
  const crumbs: Page[] = [];

  for (
    let step: Page | undefined = page;
    step && crumbs.length < MAX_CRUMBS;
    step = step.parent ? book.pages.get(step.parent) : undefined
  )
    crumbs.unshift(step);

  return crumbs;
}

function FavoriteButton({
  book,
  page,
  t,
}: {
  book: Notebook;
  page: Page;
  t: T;
}) {
  return (
    <button
      aria-label={t("favorite")}
      aria-pressed={page.favorite}
      onClick={() => book.change(page.id, { favorite: !page.favorite })}
    >
      <Star />
    </button>
  );
}

export function PhoneHeader({
  book,
  page,
  t,
  back,
  more,
  settings,
}: {
  book: Notebook;
  page: Page | null | undefined;
  t: T;
  back: () => void;
  more: (page: Page) => void;
  settings: () => void;
}) {
  return (
    <header className="top">
      {page && (
        <button className="glassbutton" aria-label={t("back")} onClick={back}>
          <ChevronLeft />
        </button>
      )}
      <span className="toptitle">
        {page ? page.title || t("untitled") : ""}
      </span>
      <span className="hidden" role="status">
        {saveState(book, t)}
      </span>
      {book.error && (
        <button className="saveerror" onClick={() => book.flush()}>
          <CloudAlert />
          <span>
            {t("unsaved")}
            <small>{t("retry")}</small>
          </span>
        </button>
      )}
      {page ? (
        <span className="glassgroup">
          <FavoriteButton book={book} page={page} t={t} />
          <button aria-label={t("more")} onClick={() => more(page)}>
            <MoreHorizontal />
          </button>
        </span>
      ) : (
        <button
          className="glassbutton"
          aria-label={t("settings")}
          onClick={settings}
        >
          <Settings />
        </button>
      )}
    </header>
  );
}

function Breadcrumbs({
  book,
  page,
  t,
  link,
  drops,
}: {
  book: Notebook;
  page: Page | null | undefined;
  t: T;
  link: PageLink;
  drops: PageDrops;
}) {
  return (
    <nav className="crumbs" aria-label={t("breadcrumb")}>
      {page ? (
        crumbsOf(book, page).map((p, index) => (
          <Fragment key={p.id}>
            {index > 0 && <span className="slash">/</span>}
            <button
              aria-current={p.id === link.current ? "page" : undefined}
              draggable
              onDragStart={(e) => startPageDrag(e, p, p.title || t("untitled"))}
              onClick={(e) => link.go(p.id, wantsNewTab(e))}
              onContextMenu={link.menu(p.id)}
              {...drops.crumb(p)}
            >
              <PageIcon page={p} />
              <span>{p.title || t("untitled")}</span>
            </button>
          </Fragment>
        ))
      ) : (
        <span className="crumbhome">
          <House />
          {t("home")}
        </span>
      )}
    </nav>
  );
}

export function DesktopHeader({
  book,
  page,
  t,
  lang,
  link,
  drops,
  side,
  showSide,
  nav,
  more,
}: {
  book: Notebook;
  page: Page | null | undefined;
  t: T;
  lang: string;
  link: PageLink;
  drops: PageDrops;
  side: boolean;
  showSide: () => void;
  nav: (direction: number) => void;
  more: (page: Page, e: MouseEvent<HTMLElement>) => void;
}) {
  const edited = page
    ? t("editedAt") + " " + since(book.editedAt(page), lang, t)
    : "";

  return (
    <header className="top">
      {!side && (
        <button aria-label={t("toggle")} onClick={showSide}>
          <Menu />
        </button>
      )}
      <button aria-label={t("back")} onClick={() => nav(-1)}>
        <ChevronLeft />
      </button>
      <button aria-label={t("forward")} onClick={() => nav(1)}>
        <ChevronRight />
      </button>
      <Breadcrumbs book={book} page={page} t={t} link={link} drops={drops} />
      <span className="status" role="status" title={edited}>
        {saveState(book, t)}
      </span>
      {book.error && <button onClick={() => book.flush()}>{t("retry")}</button>}
      {page && (
        <>
          <FavoriteButton book={book} page={page} t={t} />
          <button aria-label={t("more")} onClick={(e) => more(page, e)}>
            <MoreHorizontal />
          </button>
        </>
      )}
    </header>
  );
}

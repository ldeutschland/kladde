import { useState } from "react";
import { CornerUpRight, House, Search, Trash2, Undo2 } from "lucide-react";
import { mayMove, type Notebook, type Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { Panel, listKeys } from "../ui/dialog";
import { PageIcon } from "./tree";

const MOVE_TARGETS = 50;

function matches(page: Page, filter: string, t: T) {
  return (page.title || t("untitled"))
    .toLowerCase()
    .includes(filter.trim().toLowerCase());
}

function moveTargets(book: Notebook, moving: Page, filter: string, t: T) {
  return Array.from(book.pages.values())
    .filter(
      (p) =>
        p.kind === "page" &&
        !p.archived &&
        p.id !== moving.id &&
        p.id !== moving.parent &&
        mayMove(book.pages, moving.id, p.id) &&
        matches(p, filter, t),
    )
    .slice(0, MOVE_TARGETS);
}

export function MovePalette({
  book,
  moving,
  t,
  mobile,
  moveTo,
  close,
}: {
  book: Notebook;
  moving: Page;
  t: T;
  mobile: boolean;
  moveTo: (parent: string | null) => void;
  close: () => void;
}) {
  const [filter, setFilter] = useState("");
  const targets = moveTargets(book, moving, filter, t);

  return (
    <Panel bare title={t("moveTo")} t={t} close={close} className="palette">
      <div className="palettebody" onKeyDown={listKeys}>
        <label className="searchbox">
          <CornerUpRight />
          <input
            autoFocus
            aria-label={t("moveTo")}
            placeholder={t("searchPages")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <div className="results">
          {moving.parent !== null && (
            <button onClick={() => moveTo(null)}>
              <House />
              <span className="grow">{t("root")}</span>
            </button>
          )}
          {targets.map((p) => (
            <button key={p.id} onClick={() => moveTo(p.id)}>
              <PageIcon page={p} />
              <span className="grow">{p.title || t("untitled")}</span>
            </button>
          ))}
          {targets.length === 0 && filter && (
            <p className="muted">{t("noResults")}</p>
          )}
        </div>
      </div>
      {mobile && (
        <button className="sheetcancel" onClick={close}>
          {t("cancel")}
        </button>
      )}
    </Panel>
  );
}

function trashedPages(book: Notebook, filter: string, t: T) {
  return Array.from(book.pages.values()).filter(
    (p) =>
      p.archived &&
      !(p.parent && book.pages.get(p.parent)?.archived === p.archived) &&
      matches(p, filter, t),
  );
}

export function TrashPanel({
  book,
  t,
  restore,
  erase,
  close,
}: {
  book: Notebook;
  t: T;
  restore: (target: string) => void;
  erase: (page: Page) => void;
  close: () => void;
}) {
  const [filter, setFilter] = useState("");
  const trashed = trashedPages(book, filter, t);

  return (
    <Panel title={t("trash")} t={t} close={close} className="trash">
      <label className="searchbox">
        <Search />
        <input
          autoFocus
          aria-label={t("searchPages")}
          placeholder={t("searchPages")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
      {trashed.length === 0 && (
        <div className="emptystate">
          <Trash2 aria-hidden="true" />
          <p>{filter.trim() ? t("noResults") : t("trashEmpty")}</p>
        </div>
      )}
      {trashed.map((p) => (
        <div className="line" key={p.id}>
          <PageIcon page={p} />
          <span className="grow">{p.title || t("untitled")}</span>
          <button
            aria-label={t("restore")}
            title={t("restore")}
            onClick={() => restore(p.id)}
          >
            <Undo2 />
          </button>
          <button
            aria-label={t("erase")}
            title={t("erase")}
            onClick={() => erase(p)}
          >
            <Trash2 />
          </button>
        </div>
      ))}
    </Panel>
  );
}

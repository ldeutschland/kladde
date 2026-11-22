import { useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import {
  ChevronRight,
  Plus,
  FileText,
  Table2,
  MoreHorizontal,
  ArrowUpDown,
  Check,
  EyeOff,
} from "lucide-react";
import { Popover, listKeys } from "../ui/dialog";
import type { Notebook, Page } from "../notebook/notebook";
import {
  PAGE_SORTS,
  closedPages,
  pageSort,
  type PageSort,
} from "../notebook/pageSort";
import type { T } from "../locale/locale";
import { exclusionChecker } from "../ai/aiPages";
import { useAiOn } from "../ai/aiSwitch";
import { startPageDrag } from "../ui/dragDrop";
import {
  togglePage,
  treeChildren,
  visibleRows,
  type TreeRowItem,
} from "./treeRows";
import { useTreeDrop } from "./useTreeDrop";

const INDENT = 12;
const MAX_DEPTH = 8;
const PAGE_STEP = 100;

export function PageIcon({ page }: { page: Page }) {
  const emoji =
    page.icon && !page.icon.startsWith("kladde-file:") ? page.icon : "";

  return (
    <span className="icon">
      {emoji || (page.kind === "database" ? <Table2 /> : <FileText />)}
    </span>
  );
}

const SORT_LABELS = {
  newest: "sortNewest",
  oldest: "sortOldest",
  edited: "sortEdited",
  title: "sortTitle",
} as const satisfies Record<PageSort, string>;

export function SortButton({ book, t }: { book: Notebook; t: T }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const current = pageSort(book);

  return (
    <>
      <button
        aria-label={t("sortPages")}
        aria-haspopup="menu"
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        <ArrowUpDown />
      </button>
      {anchor && (
        <Popover
          anchor={anchor}
          label={t("sortPages")}
          close={() => setAnchor(null)}
        >
          <div className="menu" role="menu" onKeyDown={listKeys}>
            {PAGE_SORTS.map((sort) => (
              <button
                key={sort}
                role="menuitemradio"
                aria-checked={sort === current}
                autoFocus={sort === current}
                onClick={() => {
                  book.settings.set("pageSort", sort);
                  setAnchor(null);
                }}
              >
                <span className="grow">{t(SORT_LABELS[sort])}</span>
                {sort === current && <Check />}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

function indent(depth: number) {
  const left = 4 + Math.min(depth, MAX_DEPTH) * INDENT;

  return { paddingLeft: left, "--indent": left + "px" } as CSSProperties;
}

function menuAnchor(event: MouseEvent<HTMLElement>) {
  return event.type === "contextmenu"
    ? new DOMRect(event.clientX, event.clientY, 0, 0)
    : event.currentTarget.getBoundingClientRect();
}

interface TreeRowProps {
  book: Notebook;
  row: TreeRowItem;
  drop: ReturnType<typeof useTreeDrop>;
  current: boolean;
  expandable: boolean;
  expanded: boolean;
  excluded: boolean;
  t: T;
  open: (id: string, inNewTab?: boolean) => void;
  create: (parent: string) => void;
  menu: (id: string, anchor: DOMRect) => void;
}

function TreeRow({
  book,
  row: { page, depth },
  drop,
  current,
  expandable,
  expanded,
  excluded,
  t,
  open,
  create,
  menu,
}: TreeRowProps) {
  const title = page.title || t("untitled");

  function showMenu(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    menu(page.id, menuAnchor(event));
  }

  return (
    <div
      className="treerow"
      data-id={page.id}
      data-current={current}
      data-drop={drop.hint?.id === page.id ? drop.hint.place : undefined}
      data-moved={drop.moved === page.id || undefined}
      style={indent(depth)}
      draggable
      onContextMenu={showMenu}
      onDragStart={(event) => startPageDrag(event, page, title)}
      onDragEnd={() => drop.showHint(null)}
      onDragOver={(event) => drop.dragOverRow(event, page)}
      onDrop={(event) => drop.drop(event, page)}
    >
      <button
        className="disclose"
        aria-label={title + " ▸"}
        disabled={!expandable}
        aria-expanded={expanded}
        onClick={() => togglePage(book, page.id)}
      >
        <PageIcon page={page} />
        <ChevronRight className="chevron" />
      </button>
      <button
        className="treelabel"
        onClick={(event) => open(page.id, event.metaKey || event.ctrlKey)}
        onAuxClick={(event) => {
          if (event.button === 1) open(page.id, true);
        }}
      >
        <span>{title}</span>
      </button>
      {excluded && (
        <span
          className="treemark"
          role="img"
          aria-label={t("aiExcludedChip")}
          title={t("aiExcludedChip")}
        >
          <EyeOff />
        </span>
      )}
      <span className="rowtools">
        <button aria-label={t("more")} onClick={showMenu}>
          <MoreHorizontal />
        </button>
        <button aria-label={t("child")} onClick={() => create(page.id)}>
          <Plus />
        </button>
      </span>
    </div>
  );
}

export function Tree({
  book,
  open,
  current,
  t,
  create,
  menu,
  notify,
  importInto,
  root = null,
  hidden = null,
}: {
  book: Notebook;
  root?: string | null;
  hidden?: string | null;
  open: (id: string, inNewTab?: boolean) => void;
  current: string | null;
  t: T;
  create: (parent: string) => void;
  menu: (id: string, anchor: DOMRect) => void;
  notify: (text: string) => void;
  importInto: (files: File[], parent: string | null) => void;
}) {
  const closed = closedPages(book);
  const sort = pageSort(book);
  const [limit, setLimit] = useState(PAGE_STEP);
  const listed = book.pages.version;
  const children = useMemo(
    () => treeChildren(book, sort),
    [book, sort, listed],
  );
  const drop = useTreeDrop({ book, children, closed, t, notify, importInto });
  const hiddenFromAi = exclusionChecker(book.pages);
  const aiOn = useAiOn();
  const { rows, more } = visibleRows(children, { root, hidden, closed, limit });

  return (
    <div
      className="tree"
      data-drop-root={drop.hint?.id === "" || undefined}
      onDragOver={drop.dragOverTree}
      onDragLeave={drop.leaveTree}
      onDrop={(event) => drop.drop(event, null)}
    >
      {rows.map((row) => (
        <TreeRow
          key={row.page.id}
          book={book}
          row={row}
          drop={drop}
          current={row.page.id === current}
          expandable={children.has(row.page.id)}
          expanded={!closed.has(row.page.id)}
          excluded={aiOn && hiddenFromAi(row.page.id)}
          t={t}
          open={open}
          create={create}
          menu={menu}
        />
      ))}
      {more && (
        <button
          className="treemore"
          onClick={() => setLimit(limit + PAGE_STEP)}
        >
          {t("next")}
        </button>
      )}
    </div>
  );
}

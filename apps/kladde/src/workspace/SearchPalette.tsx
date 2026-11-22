import { FilePlus, Search, Settings, Sparkles, Table2 } from "lucide-react";
import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Reveal } from "../search/reveal";
import { useAiOn } from "../ai/aiSwitch";
import { Panel, listKeys } from "../ui/dialog";
import { PageIcon } from "./tree";
import { Highlight } from "../search/Highlight";
import { FileResult } from "../search/FileResult";
import { searchTerms, type SearchHit } from "../search/search";
import { wantsNewTab } from "./PageButton";
import type { Search as SearchState } from "./useSearch";

const RECENT_COUNT = 8;
const QUERY_LENGTH = 256;

interface Found {
  page: Page;
  files: SearchHit[];
  snippet: string;
}

type OpenFound = (
  target: string,
  found: Omit<Reveal, "page">,
  inNewTab?: boolean,
) => void;

export interface PaletteActions {
  openFound: OpenFound;
  askAi: (text: string) => void;
  createPage: () => void;
  createDatabase: () => void;
  settings: () => void;
  close: () => void;
}

function groupHits(book: Notebook, hits: SearchHit[]) {
  const byPage = new Map<string, Found>();

  for (const hit of hits) {
    const page = book.pages.get(hit.doc);

    if (!page || page.archived || page.kind === "chat") continue;
    const result = byPage.get(page.id) ?? { page, files: [], snippet: "" };

    byPage.set(page.id, result);
    if (hit.file) result.files.push(hit);
    else result.snippet = hit.snippet;
  }

  return Array.from(byPage.values());
}

function recentFound(book: Notebook, all: Page[]): Found[] {
  return all
    .filter((p) => !p.archived && p.kind !== "chat")
    .sort((a, b) => book.editedAt(b) - book.editedAt(a))
    .slice(0, RECENT_COUNT)
    .map((page) => ({ page, files: [], snippet: "" }));
}

function SearchResult({
  book,
  found,
  query,
  t,
  openFound,
}: {
  book: Notebook;
  found: Found;
  query: string;
  t: T;
  openFound: OpenFound;
}) {
  const { page, files, snippet } = found;
  const terms = searchTerms(query);
  const lowerQuery = query.trim().toLowerCase();
  const parent = page.parent ? book.pages.get(page.parent) : undefined;

  return (
    <div className="search-result">
      <button onClick={(e) => openFound(page.id, { terms }, wantsNewTab(e))}>
        <PageIcon page={page} />
        <span className="grow searchhit">
          <span>
            <Highlight text={page.title || t("untitled")} query={lowerQuery} />
          </span>
          {!files.length && snippet && (
            <small>
              <Highlight text={snippet} query={lowerQuery} />
            </small>
          )}
        </span>
        {parent && <small>{parent.title}</small>}
      </button>
      {files.map((hit) => (
        <FileResult
          key={hit.file}
          space={book.id}
          hit={hit}
          query={lowerQuery}
          t={t}
          open={() =>
            openFound(hit.doc, {
              terms,
              file: hit.file ?? undefined,
              index: hit.page,
              found: hit.matched || terms[0],
            })
          }
        />
      ))}
    </div>
  );
}

function SearchStatus({
  search,
  empty,
  t,
}: {
  search: SearchState;
  empty: boolean;
  t: T;
}) {
  const { query, hitsFor, indexPending, error } = search;

  if (!query.trim()) return null;

  return (
    <>
      {indexPending > 0 && (
        <p className="muted" role="status">
          {t("indexPending")} · {indexPending}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {hitsFor === query.trim() && !error && !indexPending && empty && (
        <p className="muted">{t("noResults")}</p>
      )}
    </>
  );
}

function SearchActions({
  query,
  t,
  actions,
}: {
  query: string;
  t: T;
  actions: PaletteActions;
}) {
  const lowerQuery = query.trim().toLowerCase();
  const aiOn = useAiOn();
  const quickActions = (
    [
      ["newPage", FilePlus, actions.createPage],
      ["newDb", Table2, actions.createDatabase],
      ["settings", Settings, actions.settings],
    ] as const
  ).filter(([word]) => t(word).toLowerCase().includes(lowerQuery));

  return (
    <>
      {(quickActions.length > 0 || lowerQuery) && <h4>{t("actions")}</h4>}
      {aiOn && lowerQuery && (
        <button onClick={() => actions.askAi(query.trim())}>
          <Sparkles />
          <span className="grow">
            {t("askAiShort")}: „{query.trim()}“
          </span>
        </button>
      )}
      {quickActions.map(([word, Icon, action]) => (
        <button key={word} onClick={action}>
          <Icon />
          <span className="grow">{t(word)}</span>
        </button>
      ))}
    </>
  );
}

function PaletteHints({ t }: { t: T }) {
  return (
    <footer className="palettehints" aria-hidden="true">
      <span>
        <kbd>↑</kbd>
        <kbd>↓</kbd>
        {t("hintSelect")}
      </span>
      <span>
        <kbd>↵</kbd>
        {t("hintOpen")}
      </span>
      <span>
        <kbd>⌘↵</kbd>
        {t("openInNewTab")}
      </span>
      <span>
        <kbd>esc</kbd>
        {t("close")}
      </span>
    </footer>
  );
}

export function SearchPalette({
  book,
  all,
  search,
  t,
  mobile,
  actions,
}: {
  book: Notebook;
  all: Page[];
  search: SearchState;
  t: T;
  mobile: boolean;
  actions: PaletteActions;
}) {
  const { query, setQuery } = search;
  const searching = !!query.trim();
  const found = searching
    ? groupHits(book, search.hits)
    : recentFound(book, all);

  return (
    <Panel
      bare
      title={t("search")}
      t={t}
      close={actions.close}
      className="palette"
    >
      <div className="palettebody" onKeyDown={listKeys}>
        <label className="searchbox">
          <Search />
          <input
            autoFocus
            aria-label={t("search")}
            placeholder={t(mobile ? "search" : "searchContents")}
            maxLength={QUERY_LENGTH}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="results">
          {found.length > 0 && <h4>{searching ? t("pages") : t("recent")}</h4>}
          {found.map((item) => (
            <SearchResult
              key={item.page.id}
              book={book}
              found={item}
              query={query}
              t={t}
              openFound={actions.openFound}
            />
          ))}
          <SearchStatus search={search} empty={found.length === 0} t={t} />
          <SearchActions query={query} t={t} actions={actions} />
        </div>
        {!mobile && <PaletteHints t={t} />}
      </div>
      {mobile && (
        <button className="sheetcancel" onClick={actions.close}>
          {t("cancel")}
        </button>
      )}
    </Panel>
  );
}

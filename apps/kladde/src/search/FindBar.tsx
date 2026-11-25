import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { T } from "../locale/locale";
import { useFindInPage, type FindInPage } from "./useFindInPage";

export const FIND_QUERY_LENGTH = 256;

export interface Finding {
  page: string | null;
  query: string;
  requested: number;
}

export function selectedQuery() {
  const text = getSelection()?.toString().trim() ?? "";

  return text.length <= FIND_QUERY_LENGTH && !text.includes("\n") ? text : "";
}

function findKeys(
  e: KeyboardEvent<HTMLInputElement>,
  find: FindInPage,
  close: () => void,
) {
  if (e.nativeEvent.isComposing) return;
  const again = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g";

  if (e.key === "Enter" || again) {
    e.preventDefault();
    find.step(e.shiftKey ? -1 : 1);

    return;
  }

  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  find.select();
  close();
}

function countText(find: FindInPage, query: string, t: T) {
  if (find.total)
    return t("findCount")
      .replace("{n}", String(find.current + 1))
      .replace("{total}", String(find.total));

  return query.trim() ? t("noResults") : "";
}

export function FindBar({
  root,
  finding,
  setQuery,
  t,
  close,
}: {
  root: RefObject<HTMLElement | null>;
  finding: Finding;
  setQuery: (query: string) => void;
  t: T;
  close: () => void;
}) {
  const { query, requested } = finding;
  const find = useFindInPage(root, query);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [requested]);

  return (
    <div className="findspot">
      <div className="findbar" role="search" aria-label={t("findInPage")}>
        <Search />
        <input
          ref={field}
          aria-label={t("findInPage")}
          placeholder={t("findInPageField")}
          maxLength={FIND_QUERY_LENGTH}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => findKeys(e, find, close)}
        />
        <span className="findcount" aria-live="polite">
          {countText(find, query, t)}
        </span>
        <button
          aria-label={t("findPrevious")}
          title={t("findPrevious")}
          disabled={!find.total}
          onClick={() => find.step(-1)}
        >
          <ChevronUp />
        </button>
        <button
          aria-label={t("findNext")}
          title={t("findNext")}
          disabled={!find.total}
          onClick={() => find.step(1)}
        >
          <ChevronDown />
        </button>
        <button aria-label={t("close")} title={t("close")} onClick={close}>
          <X />
        </button>
      </div>
    </div>
  );
}

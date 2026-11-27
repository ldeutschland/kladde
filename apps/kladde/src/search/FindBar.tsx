import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { T } from "../locale/locale";
import { useFindInPage } from "./useFindInPage";

export const FIND_QUERY_LENGTH = 256;

export interface Finding {
  page: string | null;
  query: string;
  requested: number;
}

export interface FoundSteps {
  total: number;
  current: number;
  searching?: boolean;
  step: (by: number) => void;
}

export function findableQuery(value: string) {
  const text = value.trim();

  return text.length <= FIND_QUERY_LENGTH && !text.includes("\n") ? text : "";
}

export function selectedQuery() {
  return findableQuery(getSelection()?.toString() ?? "");
}

function findKeys(
  e: KeyboardEvent<HTMLInputElement>,
  find: FoundSteps,
  escape: () => void,
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
  escape();
}

function countText(find: FoundSteps, query: string, t: T) {
  if (find.searching) return t("findSearching");
  if (find.total)
    return t("findCount")
      .replace("{n}", String(find.current + 1))
      .replace("{total}", String(find.total));

  return query.trim() ? t("noResults") : "";
}

export function FindField({
  label,
  placeholder,
  query,
  requested,
  find,
  setQuery,
  t,
  close,
  escape = close,
}: {
  label: string;
  placeholder: string;
  query: string;
  requested: number;
  find: FoundSteps;
  setQuery: (query: string) => void;
  t: T;
  close: () => void;
  escape?: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [requested]);

  return (
    <div className="findbar" role="search" aria-label={label}>
      <Search />
      <input
        ref={field}
        aria-label={label}
        placeholder={placeholder}
        maxLength={FIND_QUERY_LENGTH}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => findKeys(e, find, escape)}
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
  );
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
  const find = useFindInPage(root, finding.query);

  return (
    <div className="findspot">
      <FindField
        label={t("findInPage")}
        placeholder={t("findInPageField")}
        query={finding.query}
        requested={finding.requested}
        find={find}
        setQuery={setQuery}
        t={t}
        close={close}
        escape={() => {
          find.select();
          close();
        }}
      />
    </div>
  );
}

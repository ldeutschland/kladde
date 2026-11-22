import { useCallback, useEffect, useState } from "react";
import type { Notebook } from "../notebook/notebook";
import type { Reveal } from "../search/reveal";
import { searchContent, type SearchHit } from "../search/search";

const SEARCH_DELAY_MS = 80;
const PENDING_RETRY_MS = 1200;

export function useSearch(book: Notebook, active: boolean) {
  const [query, setQuery] = useState(""),
    [hits, setHits] = useState<SearchHit[]>([]),
    [hitsFor, setHitsFor] = useState(""),
    [indexPending, setIndexPending] = useState(0),
    [error, setError] = useState(""),
    [reveal, setReveal] = useState<Reveal | null>(null);
  const revealed = useCallback(() => setReveal(null), []);

  useEffect(() => {
    if (!active || !query.trim()) return;
    let current = true;

    setError("");

    async function refresh() {
      try {
        await book.flush();
        const result = await searchContent(book.id, query.trim());

        if (!current) return;
        setHits(result.hits);
        setHitsFor(query.trim());
        setIndexPending(result.pending);
        if (result.pending) timer = setTimeout(refresh, PENDING_RETRY_MS);
      } catch (problem) {
        if (current) setError(String(problem));
      }
    }

    let timer = setTimeout(refresh, SEARCH_DELAY_MS);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [active, query, book]);

  return {
    query,
    setQuery,
    hits,
    hitsFor,
    indexPending,
    error,
    reveal,
    setReveal,
    revealed,
  };
}

export type Search = ReturnType<typeof useSearch>;

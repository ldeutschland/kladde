import { useEffect, useState } from "react";
import type { Entry, Notebook } from "../notebook/notebook";
import { command } from "../platform/native";

export function usePageLinks(
  book: Notebook,
  id: string | null,
  parent: string | null | undefined,
) {
  const [links, setLinks] = useState<string[]>([]),
    [database, setDatabase] = useState<Entry | null>(null);

  useEffect(() => {
    if (!id) return;
    let current = true;

    void command<string[]>("backlinks", { id }).then((v) => {
      if (current) setLinks(v);
    });
    if (parent)
      void book.load(parent).then((e) => {
        if (current) setDatabase(e.kind === "database" ? e : null);
      });
    else setDatabase(null);

    return () => {
      current = false;
    };
  }, [id, parent, book]);

  return { links, database };
}

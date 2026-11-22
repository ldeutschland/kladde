import { useState } from "react";
import type { Selection } from "./RowsView";

export function useSelection(): Selection {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });

  return { chosen, setChosen, toggle };
}

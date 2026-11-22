import { useEffect, useMemo, useState } from "react";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Ask } from "../ui/dialog";
import { localDate } from "../database/rules";
import { addView, fields, views } from "../database/fields";
import { selectRows, summarize } from "../database/selectRows";
import { CARD_STEP } from "./BoardView";
import type { CellTarget } from "./CellEditor";
import { useRowHeights, useRows, useScrollOffset, useToday } from "./useRows";
import { useSelection } from "./useSelection";
import type { Menu } from "./types";

export interface DatabaseProps {
  book: Notebook;
  db: Entry;
  open: (id: string) => void;
  t: T;
  ask: Ask;
  mobile: boolean;
  openTab?: (id: string) => void;
}

export function useDatabaseState(props: DatabaseProps) {
  const { book, db, t, mobile } = props;
  const panels = usePanels();
  const today = useToday();
  const { rows, setRows, scope } = useRows(book, db);
  const heights = useRowHeights();
  const schema = Array.from(fields(db).values());
  const tabs = Array.from(views(db).values());
  const active = tabs.find((view) => view.id === panels.selected) ?? tabs[0];
  const scrolling = useScrollOffset(mobile, active?.id, active?.type);

  useEffect(() => {
    if (!views(db).size)
      addView(db, t(mobile ? "list" : "table"), mobile ? "list" : "table");
  }, [db, t, mobile]);
  const result = useMemo(
    () =>
      active
        ? selectRows(
            rows,
            active,
            panels.query,
            Array.from(fields(db).values()),
          )
        : [],
    [rows, active, panels.query, db, today],
  );
  const statistic = useMemo(
    () => (active?.summary ? summarize(result, active.summary) : null),
    [active, result],
  );

  return {
    ...props,
    ...panels,
    ...scrolling,
    today,
    setRows,
    scope,
    heights,
    schema,
    tabs,
    active,
    result,
    statistic,
  };
}

function usePanels() {
  const [automationOpen, showAutomations] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [query, setQuery] = useState("");
  const [selected, choose] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CellTarget | null>(null);
  const [bulkEdit, setBulkEdit] = useState<CellTarget | null>(null);
  const [cardLimit, setCardLimit] = useState(CARD_STEP);
  const [month, setMonth] = useState(() => localDate(new Date()).slice(0, 7));
  const selection = useSelection();

  return {
    automationOpen,
    showAutomations,
    menu,
    setMenu,
    query,
    setQuery,
    selected,
    choose,
    adding,
    setAdding,
    editing,
    setEditing,
    bulkEdit,
    setBulkEdit,
    cardLimit,
    setCardLimit,
    month,
    setMonth,
    selection,
  };
}

export type DatabaseState = ReturnType<typeof useDatabaseState>;

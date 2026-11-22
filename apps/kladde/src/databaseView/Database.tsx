import { BoardView, CalendarView } from "./BoardView";
import { DatabaseBar, SummaryLine } from "./DatabaseBar";
import { DatabaseOverlays } from "./DatabaseOverlays";
import { RowsView } from "./RowsView";
import { storeValue } from "./rowEdits";
import { openDatabase, type DatabaseScope } from "./databaseScope";
import { useDatabaseState, type DatabaseProps } from "./useDatabaseState";

export function Database(props: DatabaseProps) {
  const state = useDatabaseState(props);

  if (!state.active) return null;
  const database = openDatabase(state, state.active);

  return (
    <div className="database">
      <DatabaseHeader database={database} />
      <ActiveView database={database} />
      <DatabaseOverlays database={database} />
    </div>
  );
}

function DatabaseHeader({ database }: { database: DatabaseScope }) {
  const { context } = database;

  return (
    <>
      <DatabaseBar
        tabs={database.tabs}
        context={context}
        query={database.query}
        search={(next) => {
          database.setQuery(next);
          database.scroll(0);
        }}
        openMenu={database.openMenu}
        select={database.selectView}
        automations={() => database.showAutomations(true)}
        exportCsv={database.exportCsv}
        create={() => void database.create()}
      />
      <SummaryLine context={context} statistic={database.statistic} />
    </>
  );
}

function ActiveView({ database }: { database: DatabaseScope }) {
  const type = database.active.type;

  if (type === "calendar") return <CalendarLayout database={database} />;
  if (type === "board") return <BoardLayout database={database} />;

  return <RowsLayout database={database} />;
}

function CalendarLayout({ database }: { database: DatabaseScope }) {
  return (
    <CalendarView
      context={database.context}
      arranged={database.arranged}
      actions={database.rowActions}
      month={database.month}
      setMonth={database.setMonth}
      create={(value) => void database.create(value)}
    />
  );
}

function BoardLayout({ database }: { database: DatabaseScope }) {
  const { arranged, store } = database;

  return (
    <BoardView
      context={database.context}
      arranged={arranged}
      result={database.result}
      actions={database.rowActions}
      cardLimit={database.cardLimit}
      setCardLimit={database.setCardLimit}
      create={(value) => void database.create(value)}
      moveRow={(id, label) => {
        if (arranged.groupField)
          void storeValue(store, id, arranged.groupField, label);
      }}
    />
  );
}

function RowsLayout({ database }: { database: DatabaseScope }) {
  return (
    <RowsView
      context={database.context}
      arranged={database.arranged}
      span={database.span}
      result={database.result}
      selection={database.selection}
      actions={database.rowActions}
      viewport={database.viewport}
      rowList={database.heights.rowList}
      scroll={database.scroll}
      change={database.change}
      openMenu={database.openMenu}
      addField={() => database.setAdding(true)}
      create={() => void database.create()}
      bulk={{
        duplicate: () => void database.duplicateChosen(),
        trash: () => void database.trashChosen(),
      }}
    />
  );
}

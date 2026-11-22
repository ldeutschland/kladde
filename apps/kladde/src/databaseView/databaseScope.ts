import { download } from "../files/download";
import { addView, fields, views } from "../database/fields";
import { csv } from "../database/csv";
import type { Field, View } from "../database/types";
import { arrangeRows, layoutKey, visibleWindow } from "./arrange";
import type { MenuActions } from "./MenuLayer";
import { rowActionsFor } from "./rowMenu";
import {
  createRow,
  duplicateRow,
  storeValue,
  trashRow,
  type RowStore,
} from "./rowEdits";
import type { DatabaseState } from "./useDatabaseState";
import {
  addGroupField,
  changeView,
  removeField,
  updateField,
} from "./viewEdits";
import type { OpenMenu, ViewContext } from "./types";

export function openDatabase(state: DatabaseState, active: View) {
  const shown = shownViewFor(state, active);
  const chosen = chosenRowActionsFor(shown);
  const edits = viewEditActionsFor(shown);
  const { db, t, schema, result } = shown;

  return {
    ...shown,
    ...chosen,
    ...edits,
    rowActions: rowActionsFor(shown.context, shown.store, {
      t,
      open: shown.open,
      openTab: shown.openTab,
      duplicate: (id) => void duplicateRow(shown.store, id),
      trash: (id) => void trashRow(shown.store, id),
      edit: shown.setEditing,
    }),
    menuActions: menuActionsFor(shown, chosen, edits),
    exportCsv: () =>
      download(
        db.doc.getMap("meta").get("title") + ".csv",
        csv(result, schema),
        "text/csv",
      ),
  };
}

function shownViewFor(state: DatabaseState, active: View) {
  const { book, db, t, today, mobile } = state;
  const context: ViewContext = { book, db, t, today, mobile, active };
  const store: RowStore = { book, db, setRows: state.setRows };
  const arranged = arrangeRows(db, active, state.schema, state.result, mobile);
  const span = visibleWindow(
    arranged,
    state.heights.heightsFor(layoutKey(active, arranged)),
    state.offset,
  );
  const openMenu: OpenMenu = (kind, e, field) =>
    state.setMenu({
      kind,
      anchor: e.currentTarget.getBoundingClientRect(),
      field,
    });

  return {
    ...state,
    active,
    context,
    store,
    arranged,
    span,
    openMenu,
    visibleChosen: state.result.filter((row) =>
      state.selection.chosen.has(row.id),
    ),
    change: (patch: Partial<View>) => changeView(db, active, patch),
    create: async (value = "") =>
      state.open(await createRow(store, arranged.groupField, value)),
    selectView: (id: string) => {
      state.choose(id);
      state.scroll(0);
    },
  };
}

type ShownView = ReturnType<typeof shownViewFor>;

function chosenRowActionsFor(shown: ShownView) {
  const { t, store, visibleChosen, selection } = shown;

  async function duplicateChosen() {
    for (const row of visibleChosen) await duplicateRow(store, row.id);
    selection.setChosen(new Set());
  }

  async function trashChosen() {
    const confirmed = await shown.ask(
      t("trashRowsQuestion").replace("{count}", String(visibleChosen.length)),
      undefined,
      { detail: t("trashRowsDetail"), action: t("toTrash"), danger: true },
    );

    if (!confirmed) return;
    for (const row of visibleChosen) await trashRow(store, row.id);
    selection.setChosen(new Set());
  }

  async function storeMany(field: Field, raw: string) {
    let stored = true;

    for (const row of visibleChosen)
      stored = (await storeValue(store, row.id, field, raw)) && stored;

    return stored;
  }

  return { duplicateChosen, trashChosen, storeMany };
}

function viewEditActionsFor(shown: ShownView) {
  const { db, t, tabs, active, ask, setMenu } = shown;

  function toggleField(id: string) {
    const visible = shown.arranged.shown;

    if (visible.includes(id))
      shown.change({ visible: visible.filter((shownId) => shownId !== id) });
    else shown.change({ visible: [...visible, id] });
  }

  async function deleteField(id: string) {
    setMenu(null);
    const name = fields(db).get(id)?.name ?? "";
    const confirmed = await ask(
      t("deletePropertyQuestion").replace("{name}", name),
      undefined,
      { detail: t("deletePropertyDetail"), action: t("delete"), danger: true },
    );

    if (confirmed) removeField(db, tabs, id);
  }

  async function deleteView() {
    setMenu(null);
    if (tabs.length < 2) return;
    const confirmed = await ask(
      t("deleteViewQuestion").replace("{name}", active.name),
      undefined,
      { detail: t("deleteViewDetail"), action: t("delete"), danger: true },
    );

    if (!confirmed) return;
    views(db).delete(active.id);
    shown.selectView("");
  }

  return { toggleField, deleteField, deleteView };
}

function menuActionsFor(
  shown: ShownView,
  chosen: ReturnType<typeof chosenRowActionsFor>,
  edits: ReturnType<typeof viewEditActionsFor>,
): MenuActions {
  const { book, db, t, schema, setMenu } = shown;

  return {
    close: () => setMenu(null),
    change: shown.change,
    storeMany: (field, value) => void chosen.storeMany(field, value),
    bulkEdit: (field, anchor) =>
      shown.setBulkEdit({
        row: { id: "", title: "", values: {} },
        field,
        anchor,
      }),
    addView: (type) => {
      addGroupField(db, t, schema, type);
      shown.selectView(addView(db, t(type), type).id);
    },
    view: {
      toggleField: edits.toggleField,
      addField: () => {
        setMenu(null);
        shown.setAdding(true);
      },
      deleteView: () => void edits.deleteView(),
    },
    field: (field) => ({
      update: (patch) => updateField(book, db, field.id, patch),
      hide: () => {
        edits.toggleField(field.id);
        setMenu(null);
      },
      remove: () => void edits.deleteField(field.id),
    }),
  };
}

export type DatabaseScope = ReturnType<typeof openDatabase>;

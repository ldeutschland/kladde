import { useState, type DragEvent, type RefObject } from "react";
import {
  Calculator,
  Copy,
  PanelRightOpen,
  Play,
  Plus,
  SlidersHorizontal,
  Trash2,
  Type,
  X,
} from "lucide-react";
import type { Page } from "../notebook/notebook";
import type { Word } from "../locale/locale";
import { PageIcon } from "../workspace/tree";
import { startPageDrag } from "../ui/dragDrop";
import { fields } from "../database/fields";
import { readOnlyTypes, type Field, type Row } from "../database/types";
import { calculations, type Calculation } from "../database/compute";
import { Cell, calcText, pageLanguage } from "./Cell";
import { FieldIcon } from "./icons";
import { itemKey, type Arranged, type RowSpan } from "./arrange";
import type { ChangeView, OpenMenu, RowActions, ViewContext } from "./types";

const COLUMN_WIDTH = 180;
const WINDOW_ROWS = 30;
const FIELD_TYPE = "text/kladde-field";

export interface Selection {
  chosen: Set<string>;
  setChosen: (chosen: Set<string>) => void;
  toggle: (id: string) => void;
}

function CellValue({
  field,
  row,
  context,
}: {
  field: Field;
  row: Row;
  context: ViewContext;
}) {
  return (
    <span className="cellvalue">
      <Cell field={field} row={row} book={context.book} today={context.today} />
    </span>
  );
}

function TableCell({
  field,
  row,
  context,
  actions,
}: {
  field: Field;
  row: Row;
  context: ViewContext;
  actions: RowActions;
}) {
  const { active, t } = context;
  const shared = {
    title:
      field.type === "text" && !active.wrap ? row.values[field.id] : undefined,
    style: { width: active.widths[field.id] ?? COLUMN_WIDTH },
  };
  const value = <CellValue field={field} row={row} context={context} />;

  if (field.type === "button")
    return (
      <span className="cell" {...shared}>
        <button
          className="cellbutton"
          disabled={!field.rule}
          title={field.rule ? undefined : t("buttonNeedsRule")}
          onClick={() => actions.run(row, field)}
        >
          <Play size={12} />
          {field.name}
        </button>
      </span>
    );
  if (readOnlyTypes.includes(field.type))
    return (
      <span className="cell" {...shared}>
        {value}
      </span>
    );
  if (field.type === "checkbox")
    return (
      <button
        className="cell"
        {...shared}
        role="checkbox"
        aria-checked={row.values[field.id] === "true"}
        aria-label={field.name}
        onClick={() => actions.toggle(row, field)}
      >
        {value}
      </button>
    );

  return (
    <button className="cell" {...shared} onClick={actions.edit(row, field)}>
      {value}
    </button>
  );
}

function rowDrag(context: ViewContext, row: Row, page: Page | undefined) {
  if (!page || context.mobile) return {};

  return {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) =>
      startPageDrag(e, page, row.title || context.t("untitled")),
  };
}

function TableRow({
  row,
  visible,
  context,
  actions,
  selection,
}: {
  row: Row;
  visible: Field[];
  context: ViewContext;
  actions: RowActions;
  selection: Selection;
}) {
  const { book, t } = context;
  const page = book.pages.get(row.id);
  const name = row.title || t("untitled");

  return (
    <div
      className="datarow"
      role="row"
      data-key={row.id}
      data-tint={actions.tint(row)}
      data-chosen={selection.chosen.has(row.id) || undefined}
      {...rowDrag(context, row, page)}
      onContextMenu={actions.menu(row.id)}
    >
      <span className="cell titlecell">
        <input
          type="checkbox"
          className="rowcheck"
          aria-label={t("selectRow") + ": " + name}
          checked={selection.chosen.has(row.id)}
          onChange={() => selection.toggle(row.id)}
        />
        <button className="celltitle" onClick={actions.edit(row, null)}>
          {page && <PageIcon page={page} />}
          <strong>{name}</strong>
        </button>
        <button
          className="rowopen"
          aria-label={t("open") + ": " + name}
          onClick={() => actions.open(row.id)}
        >
          <PanelRightOpen />
          {t("open")}
        </button>
      </span>
      {visible.map((f) => (
        <TableCell
          key={f.id}
          field={f}
          row={row}
          context={context}
          actions={actions}
        />
      ))}
    </div>
  );
}

function RowCard({
  row,
  visible,
  gallery,
  context,
  actions,
}: {
  row: Row;
  visible: Field[];
  gallery: boolean;
  context: ViewContext;
  actions: RowActions;
}) {
  const page = context.book.pages.get(row.id);
  const filled = visible.filter((f) => row.values[f.id]).slice(0, 3);

  return (
    <button
      className={gallery ? "gallerycard" : "datarow"}
      data-key={row.id}
      data-tint={actions.tint(row)}
      {...rowDrag(context, row, page)}
      onClick={() => actions.open(row.id)}
      onContextMenu={actions.menu(row.id)}
    >
      {gallery && (
        <span className="preview">{page && <PageIcon page={page} />}</span>
      )}
      <span className="titlecell">
        {!gallery && page && <PageIcon page={page} />}
        <strong>{row.title || context.t("untitled")}</strong>
      </span>
      <span className="values">
        {filled.map((f) => (
          <span key={f.id}>
            <CellValue field={f} row={row} context={context} />
          </span>
        ))}
      </span>
    </button>
  );
}

function GroupRow({
  label,
  arranged,
  context,
}: {
  label: string;
  arranged: Arranged;
  context: ViewContext;
}) {
  const { groupField, grouped } = arranged;

  return (
    <h4 className="grouprow" data-key={itemKey(label)}>
      <span
        className="tag"
        data-color={(groupField?.options.indexOf(label) ?? -1) % 9}
      >
        {label || context.t("emptyGroup")}
      </span>
      <span className="count">{grouped.get(label)?.length ?? 0}</span>
    </h4>
  );
}

function HeadCell({
  field,
  context,
  shown,
  change,
  openMenu,
  dropping,
  setDropping,
}: {
  field: Field;
  context: ViewContext;
  shown: string[];
  change: ChangeView;
  openMenu: OpenMenu;
  dropping: boolean;
  setDropping: (id: string | null) => void;
}) {
  const { active, db } = context;

  return (
    <button
      className="cell"
      draggable
      data-drop={dropping || undefined}
      onDragStart={(e) => {
        e.dataTransfer.setData(FIELD_TYPE, field.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(FIELD_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!dropping) setDropping(field.id);
      }}
      onDragLeave={() => setDropping(null)}
      onDragEnd={() => setDropping(null)}
      onDrop={(e) => {
        setDropping(null);
        const from = e.dataTransfer.getData(FIELD_TYPE);

        if (!fields(db).has(from) || from === field.id) return;
        e.preventDefault();
        const order = shown.filter((id) => id !== from);

        order.splice(order.indexOf(field.id), 0, from);
        change({ visible: order });
      }}
      style={{ width: active.widths[field.id] ?? COLUMN_WIDTH }}
      onClick={(e) => openMenu("field", e, field.id)}
    >
      <FieldIcon field={field} />
      <span>{field.name}</span>
    </button>
  );
}

function TableHead({
  context,
  arranged,
  result,
  selection,
  change,
  openMenu,
  addField,
}: {
  context: ViewContext;
  arranged: Arranged;
  result: Row[];
  selection: Selection;
  change: ChangeView;
  openMenu: OpenMenu;
  addField: () => void;
}) {
  const [dropping, setDropping] = useState<string | null>(null);
  const { t } = context;
  const allChosen =
    result.length > 0 && result.every((r) => selection.chosen.has(r.id));

  return (
    <div className="datarow head">
      <span className="cell titlecell">
        <input
          type="checkbox"
          className="rowcheck"
          aria-label={t("selectAllRows")}
          checked={allChosen}
          onChange={() =>
            selection.setChosen(
              allChosen ? new Set() : new Set(result.map((r) => r.id)),
            )
          }
        />
        <Type size={16} />
        {t("title")}
      </span>
      {arranged.visible.map((f) => (
        <HeadCell
          key={f.id}
          field={f}
          context={context}
          shown={arranged.shown}
          change={change}
          openMenu={openMenu}
          dropping={dropping === f.id}
          setDropping={setDropping}
        />
      ))}
      <button
        className="cell addfield"
        aria-label={t("newProperty")}
        onClick={addField}
      >
        <Plus size={16} />
      </button>
    </div>
  );
}

function CalcCell({
  field,
  context,
  result,
  openMenu,
}: {
  field: Field | undefined;
  context: ViewContext;
  result: Row[];
  openMenu: OpenMenu;
}) {
  const { active, t, today } = context;
  const key = field?.id ?? "";
  const stored = active.calcs?.[key];
  const calc = calculations.includes(stored as Calculation)
    ? stored
    : undefined;
  const width = field ? (active.widths[field.id] ?? COLUMN_WIDTH) : undefined;

  return (
    <button
      className={"cell calccell" + (field ? "" : " titlecell")}
      style={width ? { width } : undefined}
      data-set={!!calc || undefined}
      onClick={(e) => openMenu("calc", e, key)}
    >
      {calc ? (
        <>
          <small>{t(calc as Word)}</small>
          <span>{calcText(calc, field, result, pageLanguage(), today)}</span>
        </>
      ) : (
        <small className="calchint">
          <Calculator size={12} />
          {t("calculate")}
        </small>
      )}
    </button>
  );
}

function BulkBar({
  context,
  count,
  openMenu,
  duplicate,
  trash,
  clear,
}: {
  context: ViewContext;
  count: number;
  openMenu: OpenMenu;
  duplicate: () => void;
  trash: () => void;
  clear: () => void;
}) {
  const { t } = context;

  return (
    <div className="bulkbar" role="toolbar" aria-label={t("selectedRows")}>
      <strong>
        {count} {t("selectedRows")}
      </strong>
      <button onClick={(e) => openMenu("bulk", e)}>
        <SlidersHorizontal size={14} />
        {t("setProperty")}
      </button>
      <button onClick={duplicate}>
        <Copy size={14} />
        {t("duplicate")}
      </button>
      <button className="danger" onClick={trash}>
        <Trash2 size={14} />
        {t("toTrash")}
      </button>
      <button
        aria-label={t("clearSelection")}
        title={t("clearSelection")}
        onClick={clear}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export interface RowsViewProps {
  context: ViewContext;
  arranged: Arranged;
  span: RowSpan;
  result: Row[];
  selection: Selection;
  actions: RowActions;
  viewport: RefObject<HTMLDivElement | null>;
  rowList: RefObject<HTMLDivElement | null>;
  scroll: (offset: number) => void;
  change: ChangeView;
  openMenu: OpenMenu;
  addField: () => void;
  create: () => void;
  bulk: { duplicate: () => void; trash: () => void };
}

function RowWindow({
  context,
  arranged,
  span,
  selection,
  actions,
  rowList,
}: RowsViewProps) {
  const { gallery, columns, items, visible } = arranged;
  const table = context.active.type === "table";
  const shownItems = items.slice(
    span.first,
    span.first + WINDOW_ROWS * columns,
  );

  return (
    <div className="rowspace" style={{ height: span.total }}>
      <div
        ref={rowList}
        className={gallery ? "cardgrid" : "rowlist"}
        style={{
          transform: "translateY(" + span.top + "px)",
          gridTemplateColumns: "repeat(" + columns + ", minmax(0, 1fr))",
        }}
      >
        {shownItems.map((item) =>
          typeof item === "string" ? (
            <GroupRow
              key={"g" + item}
              label={item}
              arranged={arranged}
              context={context}
            />
          ) : table ? (
            <TableRow
              key={item.id}
              row={item}
              visible={visible}
              context={context}
              actions={actions}
              selection={selection}
            />
          ) : (
            <RowCard
              key={item.id}
              row={item}
              visible={visible}
              gallery={gallery}
              context={context}
              actions={actions}
            />
          ),
        )}
      </div>
    </div>
  );
}

export function RowsView(props: RowsViewProps) {
  const { context, arranged, result, selection, openMenu } = props;
  const { active, t, mobile } = context;
  const table = active.type === "table";
  const chosenCount = result.filter((r) => selection.chosen.has(r.id)).length;

  return (
    <>
      {table && chosenCount > 0 && (
        <BulkBar
          context={context}
          count={chosenCount}
          openMenu={openMenu}
          duplicate={props.bulk.duplicate}
          trash={props.bulk.trash}
          clear={() => selection.setChosen(new Set())}
        />
      )}
      <div
        ref={props.viewport}
        className={"rowviewport " + active.type + (active.wrap ? " wrap" : "")}
        data-choosing={chosenCount > 0 || undefined}
        onScroll={(e) => {
          if (!mobile) props.scroll(e.currentTarget.scrollTop);
        }}
      >
        {table && (
          <TableHead
            context={context}
            arranged={arranged}
            result={result}
            selection={selection}
            change={props.change}
            openMenu={openMenu}
            addField={props.addField}
          />
        )}
        <RowWindow {...props} />
        {table && (
          <div className="datarow foot">
            <CalcCell
              field={undefined}
              context={context}
              result={result}
              openMenu={openMenu}
            />
            {arranged.visible.map((f) => (
              <CalcCell
                key={"calc" + f.id}
                field={f}
                context={context}
                result={result}
                openMenu={openMenu}
              />
            ))}
          </div>
        )}
      </div>
      <button className="addrow" onClick={props.create}>
        <Plus size={16} />
        {t("newRow")}
      </button>
    </>
  );
}

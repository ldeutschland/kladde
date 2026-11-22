import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { localDate } from "../database/rules";
import { useCardDrag, type CardDrag } from "./cardDrag";
import { type Row } from "../database/types";
import { Cell } from "./Cell";
import type { Arranged } from "./arrange";
import type { RowActions, ViewContext } from "./types";

export const CARD_STEP = 60;

function CardContent({
  row,
  arranged,
  context,
}: {
  row: Row;
  arranged: Arranged;
  context: ViewContext;
}) {
  return (
    <>
      <strong>{row.title || context.t("untitled")}</strong>
      {arranged.visible
        .filter((f) => f.id !== arranged.group && row.values[f.id])
        .slice(0, 3)
        .map((f) => (
          <span className="values" key={f.id}>
            <Cell
              field={f}
              row={row}
              book={context.book}
              today={context.today}
            />
          </span>
        ))}
    </>
  );
}

function FloatingCard({
  drag,
  result,
  arranged,
  context,
}: {
  drag: CardDrag | null;
  result: Row[];
  arranged: Arranged;
  context: ViewContext;
}) {
  const dragged = drag && result.find((r) => r.id === drag.id);

  if (!drag || !dragged) return null;

  return (
    <div
      className="boardcard floating"
      aria-hidden="true"
      style={{ left: drag.x, top: drag.y, width: drag.width }}
    >
      <CardContent row={dragged} arranged={arranged} context={context} />
    </div>
  );
}

interface BoardProps {
  context: ViewContext;
  arranged: Arranged;
  result: Row[];
  actions: RowActions;
  cardLimit: number;
  setCardLimit: (limit: number) => void;
  create: (value: string) => void;
  moveRow: (id: string, label: string) => void;
}

function BoardColumn({
  label,
  board,
}: {
  label: string;
  board: BoardProps & ReturnType<typeof useCardDrag>;
}) {
  const { context, arranged, result, actions, cardLimit, drag } = board;
  const { t } = context;
  const cards = arranged.grouped.get(label) ?? [];
  const dragged = drag && result.find((r) => r.id === drag.id);
  const over =
    !!dragged &&
    drag.column === label &&
    (dragged.values[arranged.group] ?? "") !== label;

  return (
    <section
      className="column"
      data-column={label}
      data-over={over || undefined}
    >
      <header>
        <span
          className="tag"
          data-color={(arranged.groupField?.options.indexOf(label) ?? -1) % 9}
        >
          {label || t("emptyGroup")}
        </span>
        <span className="count">{cards.length}</span>
      </header>
      {cards.slice(0, cardLimit).map((r) => (
        <button
          className="boardcard"
          key={r.id}
          data-tint={actions.tint(r)}
          data-lifted={drag?.id === r.id || undefined}
          onPointerDown={(e) => board.start(e, r.id)}
          onClick={() => {
            if (!board.wasDragged()) actions.open(r.id);
          }}
          onContextMenu={actions.menu(r.id)}
        >
          <CardContent row={r} arranged={arranged} context={context} />
        </button>
      ))}
      {over && <div className="cardslot" aria-hidden="true" />}
      {cards.length > cardLimit && (
        <button
          className="more"
          onClick={() => board.setCardLimit(cardLimit + CARD_STEP)}
        >
          {t("next")}
        </button>
      )}
      <button className="columnadd" onClick={() => board.create(label)}>
        <Plus size={16} />
        {t("newShort")}
      </button>
    </section>
  );
}

export function BoardView(props: BoardProps) {
  const cardDrag = useCardDrag(props.moveRow);
  const { drag } = cardDrag;
  const { arranged } = props;
  const labels = [
    ...new Set([
      "",
      ...(arranged.groupField?.options ?? []),
      ...arranged.grouped.keys(),
    ]),
  ];

  return (
    <div className="board" data-dragging={!!drag || undefined}>
      {labels.map((label) => (
        <BoardColumn
          key={label}
          label={label}
          board={{ ...props, ...cardDrag }}
        />
      ))}
      <FloatingCard
        drag={drag}
        result={props.result}
        arranged={arranged}
        context={props.context}
      />
    </div>
  );
}

function CalendarHead({
  first,
  context,
  shift,
  showToday,
}: {
  first: Date;
  context: ViewContext;
  shift: (delta: number) => void;
  showToday: () => void;
}) {
  const { t } = context;
  const lang = document.documentElement.lang;

  return (
    <div className="calhead">
      <strong>
        {new Intl.DateTimeFormat(lang, {
          month: "long",
          year: "numeric",
        }).format(first)}
      </strong>
      <button aria-label={t("previous")} onClick={() => shift(-1)}>
        <ChevronLeft size={16} />
      </button>
      <button onClick={showToday}>{t("today")}</button>
      <button aria-label={t("next")} onClick={() => shift(1)}>
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

function weekdayName(lang: string, index: number) {
  return new Intl.DateTimeFormat(lang, { weekday: "short" }).format(
    new Date(2024, 0, 1 + index),
  );
}

export function CalendarView({
  context,
  arranged,
  actions,
  month,
  setMonth,
  create,
}: {
  context: ViewContext;
  arranged: Arranged;
  actions: RowActions;
  month: string;
  setMonth: (month: string) => void;
  create: (value: string) => void;
}) {
  const { t } = context;
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(year, monthNumber - 1, 1);
  const days = new Date(year, monthNumber, 0).getDate();
  const blanks = (first.getDay() + 6) % 7;
  const today = localDate(new Date());
  const lang = document.documentElement.lang;
  const shift = (delta: number) =>
    setMonth(localDate(new Date(year, monthNumber - 1 + delta, 1)).slice(0, 7));

  return (
    <div className="calendarview">
      <CalendarHead
        first={first}
        context={context}
        shift={shift}
        showToday={() => setMonth(today.slice(0, 7))}
      />
      <div className="calendar">
        {Array.from({ length: 7 }, (_, i) => (
          <b className="weekday" key={"w" + i}>
            {weekdayName(lang, i)}
          </b>
        ))}
        {Array.from({ length: blanks }, (_, i) => (
          <span className="blank" key={"b" + i} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const key = month + "-" + String(i + 1).padStart(2, "0");

          return (
            <section key={key} data-today={key === today}>
              <header>
                <button
                  className="dayadd"
                  aria-label={t("newShort") + " " + key}
                  onClick={() => create(key)}
                >
                  <Plus size={14} />
                </button>
                <span className="daynumber">{i + 1}</span>
              </header>
              {(arranged.grouped.get(key) ?? []).map((r) => (
                <button
                  className="event"
                  key={r.id}
                  onClick={() => actions.open(r.id)}
                  onContextMenu={actions.menu(r.id)}
                >
                  {r.title || t("untitled")}
                </button>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

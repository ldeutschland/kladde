import { useRef, type DragEvent, type ReactNode, type RefObject } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  RotateCw,
  Trash2,
} from "lucide-react";
import { turnedSize, type Mark, type Point } from "./marks";
import { useNear, usePagePicture, type PdfSource } from "./pdfPages";
import { FoundMarks, type FoundView } from "./foundMarks";
import type { T } from "../locale/locale";
import { Sheet } from "./Sheet";
import { IconButton } from "./ViewerControls";
import { pageLabel, type PageDraft } from "./pdfDraft";
import type { Pens } from "./usePens";
import type { PageDrag } from "./usePageEdits";

const MAX_FIT = 1.5;
const THUMB_WIDTH = 104;

export function PageActions({
  index,
  count,
  t,
  turn,
  move,
  remove,
}: {
  index: number;
  count: number;
  t: T;
  turn: (index: number, by: 90 | -90) => void;
  move: (from: number, to: number) => void;
  remove: (index: number) => void;
}) {
  return (
    <div className="pageactions">
      <span>{pageLabel(t, index)}</span>
      <IconButton
        label={t("rotateLeft")}
        icon={<RotateCcw />}
        onClick={() => turn(index, -90)}
      />
      <IconButton
        label={t("rotateRight")}
        icon={<RotateCw />}
        onClick={() => turn(index, 90)}
      />
      <IconButton
        label={t("movePageUp")}
        icon={<ArrowUp />}
        disabled={index === 0}
        onClick={() => move(index, index - 1)}
      />
      <IconButton
        label={t("movePageDown")}
        icon={<ArrowDown />}
        disabled={index === count - 1}
        onClick={() => move(index, index + 1)}
      />
      <IconButton
        label={t("deletePage")}
        icon={<Trash2 />}
        disabled={count === 1}
        onClick={() => remove(index)}
      />
    </div>
  );
}

export function PdfPage({
  source,
  page,
  index,
  size,
  room,
  zoom,
  stage,
  editing,
  pens,
  change,
  t,
  found,
  children,
}: {
  source: PdfSource;
  page: PageDraft;
  index: number;
  size: Point;
  room: number;
  zoom: number;
  stage: RefObject<HTMLElement | null>;
  editing: boolean;
  pens: Pens;
  change: (index: number, marks: Mark[]) => void;
  t: T;
  found?: FoundView;
  children?: ReactNode;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const near = useNear(holder, stage);
  const picture = usePagePicture(source, page.source, near);
  const [width, height] = size;
  const [shownWidth] = turnedSize(width, height, page.turn);
  const scale = Math.min(room / shownWidth, MAX_FIT) * zoom;

  return (
    <div className="pdfsheet" ref={holder}>
      {children}
      <Sheet
        width={width}
        height={height}
        turn={page.turn}
        scale={scale}
        href={picture ?? undefined}
        marks={page.marks}
        tool={editing ? pens.tool : null}
        pen={pens.penFor(width, height)}
        change={editing ? (marks) => change(index, marks) : undefined}
        label={pageLabel(t, index)}
      >
        {found && (
          <FoundMarks
            found={found}
            width={width}
            height={height}
            stage={stage}
          />
        )}
      </Sheet>
    </div>
  );
}

export function Thumb({
  source,
  page,
  size,
  index,
  current,
  root,
  t,
  go,
  drag,
}: {
  source: PdfSource;
  page: PageDraft;
  size: Point;
  index: number;
  current: boolean;
  root: RefObject<HTMLElement | null>;
  t: T;
  go: (index: number) => void;
  drag?: PageDrag;
}) {
  const holder = useRef<HTMLButtonElement>(null);
  const near = useNear(holder, root);
  const picture = usePagePicture(source, page.source, near, true);
  const [shownWidth] = turnedSize(size[0], size[1], page.turn);

  return (
    <button
      ref={holder}
      className={"pdfthumb" + (drag?.marked ? " dropmark" : "")}
      aria-current={current ? "page" : undefined}
      aria-label={pageLabel(t, index)}
      draggable={!!drag}
      onClick={() => go(index)}
      onDragStart={() => drag?.start(index)}
      onDragOver={(event: DragEvent) => drag?.over(event, index)}
      onDrop={(event) => {
        event.preventDefault();
        drag?.drop(index);
      }}
    >
      <Sheet
        width={size[0]}
        height={size[1]}
        turn={page.turn}
        scale={THUMB_WIDTH / shownWidth}
        href={picture ?? undefined}
        marks={page.marks}
        tool={null}
        label={pageLabel(t, index)}
      />
      <small>{index + 1}</small>
    </button>
  );
}

export function Pager({
  t,
  current,
  count,
  go,
}: {
  t: T;
  current: number;
  count: number;
  go: (index: number) => void;
}) {
  return (
    <span className="viewergroup viewerpager">
      <IconButton
        label={t("previous")}
        icon={<ChevronLeft />}
        disabled={current === 0}
        onClick={() => go(current - 1)}
      />
      <span>
        {current + 1} / {count}
      </span>
      <IconButton
        label={t("next")}
        icon={<ChevronRight />}
        disabled={current >= count - 1}
        onClick={() => go(current + 1)}
      />
    </span>
  );
}

import {
  ArrowUpRight,
  Download,
  Eraser,
  Hand,
  Highlighter,
  Minus,
  Pen,
  PenLine,
  Plus,
  Redo2,
  Square,
  Type,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { COLORS, type Tool } from "./marks";
import type { T, Word } from "../locale/locale";
import type { Pens } from "./usePens";
import type { Zoom } from "./useZoom";

const MARK_TOOLS: [Tool, Word, LucideIcon][] = [
  ["hand", "toolHand", Hand],
  ["pen", "toolPen", Pen],
  ["marker", "toolMarker", Highlighter],
  ["arrow", "toolArrow", ArrowUpRight],
  ["rect", "toolRect", Square],
  ["text", "toolText", Type],
  ["eraser", "toolEraser", Eraser],
];
const SIZE_WORDS: Word[] = ["sizeThin", "sizeMedium", "sizeThick"];

export function ZoomControls({ zoom, t }: { zoom: Zoom; t: T }) {
  return (
    <span className="viewergroup viewerzoom">
      <button
        title={t("zoomOut")}
        aria-label={t("zoomOut")}
        onClick={zoom.zoomOut}
      >
        <Minus />
      </button>
      <button className="zoomvalue" title={t("zoomFit")} onClick={zoom.fit}>
        {Math.round(zoom.zoom * 100)} %
      </button>
      <button
        title={t("zoomIn")}
        aria-label={t("zoomIn")}
        onClick={zoom.zoomIn}
      >
        <Plus />
      </button>
    </span>
  );
}

export function IconButton({
  label,
  icon,
  onClick,
  pressed,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className="viewericon"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export function MarkTools({
  pens,
  t,
  extra,
}: {
  pens: Pens;
  t: T;
  extra?: ReactNode;
}) {
  return (
    <div className="viewertools" role="toolbar" aria-label={t("editFile")}>
      <span className="viewergroup">
        {MARK_TOOLS.map(([tool, word, Icon]) => (
          <IconButton
            key={tool}
            label={t(word)}
            icon={<Icon />}
            pressed={pens.tool === tool}
            onClick={() => pens.setTool(tool)}
          />
        ))}
      </span>
      {pens.kind && (
        <span className="viewergroup">
          {COLORS.map((color) => (
            <button
              key={color}
              className="colordot"
              title={t("color")}
              aria-label={t("color") + " " + color}
              aria-pressed={pens.color === color}
              onClick={() => pens.setColor(color)}
            >
              <span style={{ background: color }} />
            </button>
          ))}
        </span>
      )}
      {pens.kind && (
        <span className="viewergroup">
          {SIZE_WORDS.map((word, size) => (
            <button
              key={word}
              className="thickness"
              title={t(word)}
              aria-label={t(word)}
              aria-pressed={pens.size === size}
              onClick={() => pens.setSize(size)}
            >
              <span style={{ width: 4 + size * 4, height: 4 + size * 4 }} />
            </button>
          ))}
        </span>
      )}
      {extra}
    </div>
  );
}

export function EditActions({
  t,
  saving,
  changed,
  canRedo,
  undo,
  redo,
  cancel,
  save,
  mobile,
}: {
  t: T;
  saving: boolean;
  changed: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  cancel: () => void;
  save: (copy: boolean) => void;
  mobile: boolean;
}) {
  return (
    <>
      <span className="viewergroup">
        <IconButton
          label={t("undo")}
          icon={<Undo2 />}
          disabled={!changed || saving}
          onClick={undo}
        />
        <IconButton
          label={t("redo")}
          icon={<Redo2 />}
          disabled={!canRedo || saving}
          onClick={redo}
        />
      </span>
      <button
        className="viewertext viewercancel"
        disabled={saving}
        onClick={cancel}
      >
        {t("cancel")}
      </button>
      {!mobile && (
        <button
          className="viewertext"
          disabled={!changed || saving}
          onClick={() => save(true)}
        >
          {t("saveCopy")}
        </button>
      )}
      <button
        className="primary"
        disabled={!changed || saving}
        onClick={() => save(false)}
      >
        {saving ? t("saving") : t("save")}
      </button>
    </>
  );
}

export function ViewActions({
  t,
  editable,
  edit,
  download,
}: {
  t: T;
  editable: boolean;
  edit: () => void;
  download: () => void;
}) {
  return (
    <>
      {editable && (
        <button className="viewertext" onClick={edit}>
          <PenLine />
          <span>{t("editFile")}</span>
        </button>
      )}
      <IconButton
        label={t("downloadFile")}
        icon={<Download />}
        onClick={download}
      />
    </>
  );
}

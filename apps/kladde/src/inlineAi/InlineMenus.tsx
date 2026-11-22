import { ArrowDownToLine, Check, RotateCcw, Sparkles, X } from "lucide-react";
import type { T, Word } from "../locale/locale";
import type { Policy } from "../ai/assistant";
import { ACTION_ICONS } from "./actions";

export function InlineSetup({
  t,
  policy,
  setup,
  close,
}: {
  t: T;
  policy: Policy;
  setup: () => void;
  close: () => void;
}) {
  return (
    <div className="inlinesetup">
      <Sparkles />
      <span className="grow">{policy.enabled ? t("aiSetup") : t("aiOff")}</span>
      <button className="primary" onClick={setup}>
        {t("setUp")}
      </button>
      <button aria-label={t("close")} onClick={close}>
        <X />
      </button>
    </div>
  );
}

export function ResultMenu({
  t,
  canReplace,
  replace,
  insertBelow,
  retry,
  close,
}: {
  t: T;
  canReplace: boolean;
  replace: () => void;
  insertBelow: () => void;
  retry: () => void;
  close: () => void;
}) {
  return (
    <div className="inlinemenu" role="menu">
      {canReplace && (
        <button role="menuitem" onClick={replace}>
          <Check />
          {t("replace")}
        </button>
      )}
      <button role="menuitem" onClick={insertBelow}>
        <ArrowDownToLine />
        {t("insertBelow")}
      </button>
      <button role="menuitem" onClick={retry}>
        <RotateCcw />
        {t("retry")}
      </button>
      <button role="menuitem" onClick={close}>
        <X />
        {t("discard")}
      </button>
    </div>
  );
}

export function ActionMenu({
  t,
  title,
  shown,
  highlight,
  setHighlight,
  choose,
}: {
  t: T;
  title: string;
  shown: Word[];
  highlight: number;
  setHighlight: (index: number) => void;
  choose: (word: Word) => void;
}) {
  return (
    <div className="inlinemenu" role="menu">
      <small>{title}</small>
      {shown.map((word, index) => {
        const Icon = ACTION_ICONS[word] ?? Sparkles;

        return (
          <button
            role="menuitem"
            key={word}
            data-active={index === highlight || undefined}
            onMouseEnter={() => setHighlight(index)}
            onClick={() => choose(word)}
          >
            <Icon />
            {t(word)}
          </button>
        );
      })}
    </div>
  );
}

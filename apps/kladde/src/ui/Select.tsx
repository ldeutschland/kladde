import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, listKeys } from "./dialog";

export interface Choice {
  value: string;
  label: string;
}

const SEARCHABLE_FROM = 10;
const MIN_MENU_WIDTH = 200;

export function ChoiceMenu({
  label,
  value,
  choices,
  pick,
  searchLabel = label,
}: {
  label: string;
  value: string;
  choices: Choice[];
  pick: (value: string) => void;
  searchLabel?: string;
}) {
  const [filter, setFilter] = useState("");
  const searchable = choices.length >= SEARCHABLE_FROM;
  const needle = filter.trim().toLowerCase();
  const shown = choices.filter((choice) =>
    choice.label.toLowerCase().includes(needle),
  );

  return (
    <div
      className="menu selectmenu"
      role="listbox"
      aria-label={label}
      onKeyDown={listKeys}
    >
      {searchable && (
        <input
          aria-label={searchLabel}
          placeholder={searchLabel}
          autoFocus
          maxLength={200}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {shown.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="option"
          aria-selected={choice.value === value}
          autoFocus={!searchable && choice.value === value}
          onClick={() => pick(choice.value)}
        >
          <span className="grow">{choice.label}</span>
          {choice.value === value && <Check />}
        </button>
      ))}
    </div>
  );
}

export function Select({
  label,
  value,
  choices,
  change,
  className = "",
  searchLabel = label,
  shown,
}: {
  label: string;
  value: string;
  choices: Choice[];
  change: (value: string) => void;
  className?: string;
  searchLabel?: string;
  shown?: string;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const current = choices.find((choice) => choice.value === value);
  const pick = (next: string) => {
    setAnchor(null);
    if (next !== value) change(next);
  };

  return (
    <>
      <button
        type="button"
        className={"select " + className}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        <span className="selectvalue">{shown ?? current?.label ?? ""}</span>
        <ChevronDown />
      </button>
      {anchor && (
        <Popover
          anchor={anchor}
          label={label}
          close={() => setAnchor(null)}
          width={Math.max(anchor.width, MIN_MENU_WIDTH)}
        >
          <ChoiceMenu
            label={label}
            value={value}
            choices={choices}
            pick={pick}
            searchLabel={searchLabel}
          />
        </Popover>
      )}
    </>
  );
}

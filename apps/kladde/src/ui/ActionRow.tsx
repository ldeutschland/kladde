import { useRef } from "react";
import type { LucideIcon } from "lucide-react";

interface Row {
  icon: LucideIcon;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export function ActionRow({
  icon: Icon,
  label,
  hint,
  disabled,
  run,
}: Row & { run: () => void }) {
  return (
    <button
      type="button"
      className="actionrow"
      disabled={disabled}
      onClick={run}
    >
      <Icon />
      <span className="grow">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </button>
  );
}

export function FileAction({
  accept,
  multiple = false,
  folder = false,
  pick,
  ...row
}: Row & {
  accept?: string;
  multiple?: boolean;
  folder?: boolean;
  pick: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <ActionRow {...row} run={() => input.current?.click()} />
      <input
        ref={(element) => {
          input.current = element;
          if (folder) element?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        accept={accept}
        multiple={multiple || folder}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);

          e.target.value = "";
          if (files.length) pick(files);
        }}
      />
    </>
  );
}

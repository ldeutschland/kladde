import { useLayoutEffect, useRef } from "react";

export function selectTitle() {
  requestAnimationFrame(() => {
    const title = document.querySelector<HTMLTextAreaElement>(
      ".document .pagetitle",
    );

    title?.focus();
    title?.select();
  });
}

export function TitleField({
  value,
  label,
  placeholder,
  change,
  leave,
}: {
  value: string;
  label: string;
  placeholder: string;
  change: (value: string) => void;
  leave?: (split: boolean) => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = field.current;

    if (!element) return;
    element.style.height = "auto";
    element.style.height = element.scrollHeight + "px";
  }, [value]);

  return (
    <textarea
      ref={field}
      className="pagetitle"
      aria-label={label}
      placeholder={placeholder}
      rows={1}
      maxLength={200}
      autoFocus={!value}
      value={value}
      onChange={(e) => change(e.target.value.replace(/\n/g, ""))}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        const atEnd = e.currentTarget.selectionStart === value.length;

        if (e.key === "Enter" || (e.key === "ArrowDown" && atEnd)) {
          e.preventDefault();
          leave?.(e.key === "Enter");
        }
      }}
    />
  );
}

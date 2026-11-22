import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

function fitHeight(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = element.scrollHeight + "px";
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => fitHeight(field.current), [props.value]);

  return (
    <textarea
      rows={1}
      {...props}
      ref={field}
      onInput={(e) => {
        fitHeight(e.currentTarget);
        props.onInput?.(e);
      }}
    />
  );
}

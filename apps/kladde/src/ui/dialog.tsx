import * as Dialog from "@radix-ui/react-dialog";
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { X } from "lucide-react";
import type { T } from "../locale/locale";

const POPOVER_ROOM = 320;

export function Panel({
  title,
  children,
  close,
  t,
  className = "",
  bare = false,
  focus,
  keep = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  t: T;
  className?: string;
  bare?: boolean;
  focus?: RefObject<HTMLElement | null>;
  keep?: boolean;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="shade" />
        <Dialog.Content
          aria-describedby={undefined}
          className={"panel " + className}
          onInteractOutside={(event) => {
            if (keep) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            if (!focus?.current) return;
            event.preventDefault();
            focus.current.focus();
          }}
        >
          {bare ? (
            <Dialog.Title className="hidden">{title}</Dialog.Title>
          ) : (
            <header>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Close aria-label={t("close")}>
                <X size={18} />
              </Dialog.Close>
            </header>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Popover({
  anchor,
  label,
  close,
  children,
  width = 260,
  cover = false,
}: {
  anchor: DOMRect;
  label: string;
  close: () => void;
  children: ReactNode;
  width?: number;
  cover?: boolean;
}) {
  const left = Math.max(8, Math.min(anchor.left, innerWidth - width - 8));
  const spaceBelow = innerHeight - anchor.bottom;
  const above = !cover && spaceBelow < POPOVER_ROOM && anchor.top > spaceBelow;
  const below = cover ? anchor.top : anchor.bottom + 4;
  const top = Math.max(8, Math.min(below, innerHeight - POPOVER_ROOM));
  const position = {
    "--x": left + "px",
    "--y": top + "px",
    "--w": width + "px",
    "--b": innerHeight - anchor.top + 4 + "px",
  } as CSSProperties;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="clear" />
        <Dialog.Content
          aria-describedby={undefined}
          className={above ? "popover above" : "popover"}
          style={position}
        >
          <Dialog.Title className="hidden">{label}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function listKeys(e: KeyboardEvent<HTMLElement>) {
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)"),
  );

  if (!items.length || e.nativeEvent.isComposing) return;
  const field = e.currentTarget.querySelector("input");

  if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
    e.preventDefault();
    items[0].dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
      }),
    );

    return;
  }

  const typing = e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;

  if (typing && field && e.target !== field) {
    field.focus();

    return;
  }

  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next = e.key === "ArrowDown" ? index + 1 : index - 1;

  if (index === -1 && e.key === "ArrowUp") next = items.length - 1;
  if (next >= items.length) next = 0;
  if (next < 0) next = items.length - 1;
  items[next].focus();
}
export type AskOptions = {
  secret?: boolean;
  detail?: string;
  action?: string;
  danger?: boolean;
  placeholder?: string;
};
export type Ask = (
  label: string,
  initial?: string,
  options?: AskOptions,
) => Promise<string | null>;
type Question = AskOptions & {
  label: string;
  initial?: string;
  resolve: (v: string | null) => void;
};

export function useAsk(t: T): [Ask, ReactNode] {
  const [question, setQuestion] = useState<Question | null>(null);
  const end = (value: string | null) => {
    question?.resolve(value);
    setQuestion(null);
  };

  return [
    (label, initial, options) =>
      new Promise((resolve) =>
        setQuestion({ ...options, label, initial, resolve }),
      ),
    question && <AskPanel question={question} end={end} t={t} />,
  ];
}

function AskPanel({
  question,
  end,
  t,
}: {
  question: Question;
  end: (value: string | null) => void;
  t: T;
}) {
  const wantsText = question.initial !== undefined;
  const field = useRef<HTMLInputElement>(null);

  return (
    <Panel
      title={question.label}
      t={t}
      close={() => end(null)}
      className="ask"
      focus={field}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          end(String(new FormData(e.currentTarget).get("value") ?? "yes"));
        }}
      >
        {question.detail && <p className="askdetail">{question.detail}</p>}
        {wantsText && (
          <input
            ref={field}
            name="value"
            type={question.secret ? "password" : "text"}
            autoComplete="off"
            aria-label={question.label}
            placeholder={question.placeholder}
            required
            maxLength={2048}
            autoFocus
            defaultValue={question.initial}
          />
        )}
        <footer>
          <button type="button" onClick={() => end(null)}>
            {t("cancel")}
          </button>
          <button
            className={question.danger ? "dangerbutton" : "primary"}
            autoFocus={!wantsText && !question.danger}
          >
            {question.action ?? t("confirm")}
          </button>
        </footer>
      </form>
    </Panel>
  );
}

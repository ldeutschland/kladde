import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import type { T } from "../locale/locale";
import { IconButton } from "./ViewerControls";

export function ViewerFrame({
  title,
  close,
  escape,
  t,
  center,
  end,
  tools,
  side,
  stage,
  children,
  footer,
  keys,
}: {
  title: string;
  close: () => void;
  escape: () => void;
  t: T;
  center?: ReactNode;
  end: ReactNode;
  tools?: ReactNode;
  side?: ReactNode;
  stage: (node: HTMLDivElement | null) => void;
  children: ReactNode;
  footer?: ReactNode;
  keys?: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          className="viewer"
          aria-describedby={undefined}
          onKeyDown={keys}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            escape();
          }}
        >
          <header className="viewerbar">
            <span className="viewertitle">
              <IconButton label={t("close")} icon={<X />} onClick={close} />
              <Dialog.Title>{title}</Dialog.Title>
            </span>
            <span className="viewercenter">{center}</span>
            <span className="viewerend">{end}</span>
          </header>
          {tools}
          <div className="viewerbody">
            {side}
            <div className="viewerstage" ref={stage} tabIndex={-1}>
              {children}
            </div>
          </div>
          {footer}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

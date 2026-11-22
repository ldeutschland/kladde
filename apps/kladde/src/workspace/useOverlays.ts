import { useState, type MouseEvent } from "react";
import type { Modal, Popup, PopupKind, RowPeek } from "./types";

export function useOverlays(initialSync: boolean) {
  const [modal, setModal] = useState<Modal>(initialSync ? "sync" : null),
    [popup, setPopup] = useState<Popup>(null),
    [moving, setMoving] = useState<string | null>(null),
    [row, setRow] = useState<RowPeek>(null),
    [photo, setPhoto] = useState<File>();

  function showSheet(kind: "page" | "add", target: string) {
    setPopup({
      kind,
      id: target,
      anchor: new DOMRect(0, innerHeight, innerWidth, 0),
    });
  }

  function showPopup(
    kind: PopupKind,
    target: string,
    e: MouseEvent<HTMLElement>,
  ) {
    setPopup({
      kind,
      id: target,
      anchor: e.currentTarget.getBoundingClientRect(),
    });
  }

  const pageMenu = (target: string) => (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    setPopup({
      kind: "page",
      id: target,
      anchor: new DOMRect(e.clientX, e.clientY, 0, 0),
    });
  };

  function closeCapture() {
    setModal(null);
    setPhoto(undefined);
  }

  return {
    modal,
    setModal,
    popup,
    setPopup,
    moving,
    setMoving,
    row,
    setRow,
    photo,
    setPhoto,
    showSheet,
    showPopup,
    pageMenu,
    closeCapture,
  };
}

export type Overlays = ReturnType<typeof useOverlays>;

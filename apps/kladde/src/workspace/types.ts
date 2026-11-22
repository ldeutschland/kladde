import type { MouseEvent } from "react";
import type { Entry } from "../notebook/notebook";

export type Modal =
  | "search"
  | "settings"
  | "trash"
  | "history"
  | "sync"
  | "transfer"
  | "capture"
  | "voice"
  | "record"
  | "clipper"
  | "privacy"
  | null;

export type PopupKind =
  "page" | "icon" | "cover" | "books" | "rename" | "ai" | "add";

export type Popup = {
  kind: PopupKind;
  id: string;
  anchor: DOMRect;
} | null;

export type Toast = {
  text: string;
  undo?: () => void;
  open?: () => void;
  busy?: boolean;
} | null;

export type DropZone =
  | "cover"
  | "icon"
  | "trash"
  | "tabs"
  | "favorites"
  | "root"
  | "home"
  | `crumb:${string}`;

export type RowPeek = { entry: Entry; db: Entry } | null;

export type Go = (target: string | null, inNewTab?: boolean) => void;

export type PageMenu = (target: string) => (e: MouseEvent<HTMLElement>) => void;

export interface PageLink {
  current: string | null;
  go: Go;
  menu: PageMenu;
}

export type ImageKey = "icon" | "cover";

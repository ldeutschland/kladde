import type { MouseEvent, ReactNode } from "react";
import {
  ChevronsLeft,
  ChevronsUpDown,
  CloudAlert,
  CloudCheck,
  CloudOff,
  House,
  LoaderCircle,
  Scissors,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Trash2,
} from "lucide-react";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { syncDetails, syncLabel } from "../sync/sync";
import { useAiOn } from "../ai/aiSwitch";
import { firstLetter } from "./commands";
import { RailResizer } from "./Rail";
import type { Sync } from "./useSyncStatus";
import type { PageDrops } from "./usePageDrops";

const SYNC_ICONS = {
  off: CloudOff,
  syncing: LoaderCircle,
  synced: CloudCheck,
  offline: CloudOff,
  auth: CloudAlert,
  outdated: CloudAlert,
  error: CloudAlert,
};

export interface RailParts {
  brand: ReactNode;
  lists: ReactNode;
  trash: ReactNode;
  sync: ReactNode;
}

export function BookButton({
  name,
  t,
  show,
}: {
  name: string;
  t: T;
  show: (e: MouseEvent<HTMLElement>) => void;
}) {
  return (
    <button
      className="brand"
      aria-label={t("workspace") + ": " + name}
      onClick={show}
    >
      <span className="avatar">{firstLetter(name)}</span>
      <span className="brandname">{name}</span>
      <ChevronsUpDown size={14} />
    </button>
  );
}

export function TrashButton({
  t,
  drop,
  open,
}: {
  t: T;
  drop: PageDrops["trash"];
  open: () => void;
}) {
  return (
    <button {...drop} onClick={open}>
      <Trash2 />
      {t("trash")}
    </button>
  );
}

export function SyncButton({
  book,
  sync,
  t,
  open,
}: {
  book: Notebook;
  sync: Sync;
  t: T;
  open: () => void;
}) {
  const Icon = SYNC_ICONS[sync.shown.phase];
  const titleOf = (target: string) =>
    book.pages.get(target)?.title || t("untitled");

  return (
    <button
      className={"syncstate " + sync.shown.phase}
      title={syncDetails(sync.seen, t, titleOf).join("\n")}
      onClick={open}
    >
      <Icon className={sync.shown.phase === "syncing" ? "spin" : undefined} />
      {syncLabel(sync.shown, t)}
    </button>
  );
}

export function SharedBadge({
  count,
  mobile,
}: {
  count: number;
  mobile: boolean;
}) {
  return count > 0 ? <b>{count}</b> : !mobile && <kbd>⌘⌥⇧N</kbd>;
}

export function Sidebar({
  parts,
  t,
  rail,
  setRail,
  shared,
  homeShown,
  aiOpen,
  actions,
}: {
  parts: RailParts;
  t: T;
  rail: number;
  setRail: (width: number) => void;
  shared: number;
  homeShown: boolean;
  aiOpen: boolean;
  actions: {
    hide: () => void;
    create: () => void;
    search: () => void;
    home: () => void;
    toggleAi: () => void;
    capture: () => void;
    clipWeb: () => void;
    settings: () => void;
  };
}) {
  const aiOn = useAiOn();

  return (
    <aside style={{ width: rail }}>
      <div className="sidetop">
        {parts.brand}
        <button aria-label={t("toggle")} onClick={actions.hide}>
          <ChevronsLeft />
        </button>
        <button aria-label={t("newPage")} onClick={actions.create}>
          <SquarePen />
        </button>
      </div>
      <nav className="railnav">
        <button onClick={actions.search}>
          <Search />
          {t("search")}
          <kbd>⌘K</kbd>
        </button>
        <button data-current={homeShown || undefined} onClick={actions.home}>
          <House />
          {t("home")}
        </button>
        {aiOn && (
          <button data-current={aiOpen || undefined} onClick={actions.toggleAi}>
            <Sparkles />
            {t("ai")}
            <kbd>⌘J</kbd>
          </button>
        )}
        <button onClick={actions.capture}>
          <SquarePen />
          {t("capture")}
          <SharedBadge count={shared} mobile={false} />
        </button>
        <button onClick={actions.clipWeb}>
          <Scissors />
          {t("webClip")}
        </button>
        <button onClick={actions.settings}>
          <Settings />
          {t("settings")}
        </button>
      </nav>
      {parts.lists}
      <nav className="railnav railfoot">
        {parts.trash}
        {parts.sync}
      </nav>
      <RailResizer rail={rail} setRail={setRail} t={t} />
    </aside>
  );
}

export function PagesContent({
  parts,
  t,
  shared,
  capture,
  settings,
}: {
  parts: RailParts;
  t: T;
  shared: number;
  capture: () => void;
  settings: () => void;
}) {
  return (
    <>
      <h1>{t("pages")}</h1>
      {parts.brand}
      {parts.lists}
      <nav className="railnav railfoot">
        <button onClick={capture}>
          <SquarePen />
          {t("capture")}
          {shared > 0 && <b>{shared}</b>}
        </button>
        {parts.trash}
        {parts.sync}
        <button onClick={settings}>
          <Settings />
          {t("settings")}
        </button>
      </nav>
    </>
  );
}

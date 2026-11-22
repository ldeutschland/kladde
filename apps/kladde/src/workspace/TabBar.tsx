import { useState } from "react";
import { House, Plus, X } from "lucide-react";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { PageIcon } from "./tree";
import {
  allowDrop,
  carriesTab,
  droppedTab,
  startTabDrag,
} from "../ui/dragDrop";
import {
  closeTab,
  moveTab,
  selectTab,
  tabPage,
  type Tab,
  type TabSet,
} from "./tabs";
import type { PageDrops } from "./usePageDrops";

interface TabControls {
  tabs: TabSet;
  setTabs: (next: TabSet) => void;
  switchTo: (next: TabSet | null) => void;
}

function AppTab({
  tab,
  target,
  book,
  t,
  controls,
  dropping,
  setDropping,
}: {
  tab: Tab;
  target: string | null;
  book: Notebook;
  t: T;
  controls: TabControls;
  dropping: boolean;
  setDropping: (key: string | null) => void;
}) {
  const { tabs, setTabs, switchTo } = controls;
  const current = tab.key === tabs.active;
  const shown = target ? book.pages.get(target) : undefined;
  const title = shown ? shown.title || t("untitled") : t("home");

  return (
    <div
      className="apptab"
      data-active={current}
      draggable
      data-drop={dropping || undefined}
      onDragStart={(e) => startTabDrag(e, tab.key)}
      onDragEnd={() => setDropping(null)}
      onDragOver={(e) => {
        if (!carriesTab(e)) return;
        allowDrop(e, "move");
        e.stopPropagation();
        if (!dropping) setDropping(tab.key);
      }}
      onDragLeave={() => setDropping(null)}
      onDrop={(e) => {
        if (!carriesTab(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(null);
        const next = moveTab(tabs, droppedTab(e), tab.key);

        if (next) setTabs(next);
      }}
    >
      <button
        role="tab"
        aria-selected={current}
        title={title}
        onClick={() => switchTo(selectTab(tabs, tab.key))}
        onAuxClick={(e) => {
          if (e.button === 1) switchTo(closeTab(tabs, tab.key));
        }}
      >
        {shown ? <PageIcon page={shown} /> : <House />}
        <span>{title}</span>
      </button>
      {tabs.list.length > 1 && (
        <button
          className="tabclose"
          aria-label={t("closeTab") + ": " + title}
          onClick={() => switchTo(closeTab(tabs, tab.key))}
        >
          <X />
        </button>
      )}
    </div>
  );
}

export function TabBar({
  book,
  t,
  current,
  reachable,
  controls,
  openTab,
  drop,
}: {
  book: Notebook;
  t: T;
  current: string | null;
  reachable: (target: string | null) => string | null;
  controls: TabControls;
  openTab: (target: string | null) => void;
  drop: PageDrops["tabs"];
}) {
  const [dropping, setDropping] = useState<string | null>(null);
  const targetOf = (tab: Tab) =>
    tab.key === controls.tabs.active ? current : reachable(tabPage(tab));

  return (
    <div className="tabbar" role="tablist" aria-label={t("tabs")} {...drop}>
      {controls.tabs.list.map((tab) => (
        <AppTab
          key={tab.key}
          tab={tab}
          target={targetOf(tab)}
          book={book}
          t={t}
          controls={controls}
          dropping={dropping === tab.key}
          setDropping={setDropping}
        />
      ))}
      <button
        className="tabadd"
        aria-label={t("newTab")}
        title={t("newTab") + " (⌘T)"}
        onClick={() => openTab(null)}
      >
        <Plus />
      </button>
    </div>
  );
}

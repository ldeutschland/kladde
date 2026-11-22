import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Entry, Notebook } from "../notebook/notebook";
import { rememberScreen, type RootTab } from "../platform/chrome";
import { rememberView, restoreView, viewKey } from "./viewMemory";
import {
  activeTab,
  addTab,
  moveInHistory,
  startTabs,
  tabPage,
  visit,
  type TabSet,
} from "./tabs";

interface NavigationOptions {
  book: Notebook;
  mobile: boolean;
  nativeChrome: boolean;
  leave: () => void;
}

function reachablePage(book: Notebook, target: string | null) {
  const found = target ? book.pages.get(target) : undefined;

  return found && !found.archived ? target : null;
}

function useShownPage({
  book,
  mobile,
  nativeChrome,
  leave,
}: NavigationOptions) {
  const [id, setId] = useState<string | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const latest = useRef(0);
  const view = useRef<HTMLElement>(null);
  const restoring = useRef(false);
  const show = useCallback(
    async (target: string | null, restore = false) => {
      const token = ++latest.current;

      await book.flush();
      const next = target ? await book.load(target) : null;

      if (nativeChrome) await rememberScreen(view.current?.dataset.view);
      if (token !== latest.current) return false;
      rememberView(view.current, mobile && !nativeChrome);
      restoring.current = restore;
      setEntry(next);
      setId(target);
      leave();

      return true;
    },
    [book, mobile, nativeChrome, leave],
  );

  return { id, entry, view, restoring, show };
}

function useViewRestore(
  view: RefObject<HTMLElement | null>,
  restoring: RefObject<boolean>,
  entry: Entry | null,
  tab: RootTab,
) {
  useLayoutEffect(() => {
    if (!restoring.current || !view.current) return;
    restoring.current = false;
    restoreView(view.current);
  }, [entry, tab]);
}

export function usePageNavigation(options: NavigationOptions) {
  const { book } = options;
  const { id, entry, view, restoring, show } = useShownPage(options);
  const [tab, setTab] = useState<RootTab>("home");
  const [tabSet, setTabSet] = useState<TabSet>(startTabs);
  const page = id ? book.pages.get(id) : null;
  const open = useCallback(
    async (target: string | null) => {
      if (await show(target)) setTabSet((set) => visit(set, target));
    },
    [show],
  );
  const reachable = (target: string | null) => reachablePage(book, target);
  const switchTo = (next: TabSet | null) => {
    if (!next) return;
    setTabSet(next);
    void show(reachable(tabPage(activeTab(next))), true);
  };
  const nav = (direction: number) => switchTo(moveInHistory(tabSet, direction));
  const openInNewTab = (target: string | null) => {
    const next = addTab(tabSet, target);

    if (next) switchTo(next);

    return !!next;
  };
  const previousStep = moveInHistory(tabSet, -1);
  const behind = viewKey(
    previousStep ? reachable(tabPage(activeTab(previousStep))) : null,
    tab,
  );

  function goBack() {
    if (previousStep) {
      switchTo(previousStep);

      return;
    }

    void show(null, true).then((shown) => {
      if (shown) setTabSet((set) => visit(set, null));
    });
  }

  function showTab(next: RootTab) {
    rememberView(view.current, false);
    restoring.current = !id;
    setTab(next);
    if (id) void open(null);
  }

  function canStep(direction: number) {
    if (direction > 0) return !!moveInHistory(tabSet, 1);

    return !!page || !!previousStep;
  }

  useViewRestore(view, restoring, entry, tab);

  return {
    id,
    page,
    entry,
    tab,
    tabSet,
    setTabSet,
    view,
    behind,
    open,
    show,
    reachable,
    switchTo,
    nav,
    openInNewTab,
    goBack,
    showTab,
    canStep,
  };
}

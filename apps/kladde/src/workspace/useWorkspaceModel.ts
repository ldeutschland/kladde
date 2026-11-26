import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Notebook } from "../notebook/notebook";
import type { Finding } from "../search/FindBar";
import { useAsk } from "../ui/dialog";
import { openRow, type WorkspaceContext } from "./pageActions";
import { useRail } from "./Rail";
import { useToast } from "./Toasts";
import { useActiveEditor } from "./useActiveEditor";
import { useAiPanel } from "./useAiPanel";
import { useAppearance } from "./useAppearance";
import { useBookEvents } from "./useBookEvents";
import { useQuickCapture, useSharedItems } from "./useCaptureSources";
import { useClipInbox } from "./useClipInbox";
import { useOverlays } from "./useOverlays";
import { usePageLinks } from "./usePageLinks";
import { usePageNavigation } from "./usePageNavigation";
import { useSearch } from "./useSearch";
import { useSyncStatus } from "./useSyncStatus";

export interface WorkspaceProps {
  book: Notebook;
  mobile: boolean;
  books: [string, string][];
  changeBook: (id?: string) => Promise<void>;
  reloadBooks: () => Promise<void>;
  initialSync: boolean;
}

export function useWorkspaceModel(props: WorkspaceProps) {
  const { book, mobile } = props;

  useSyncExternalStore(book.subscribe, book.snapshot);
  const { lang, theme, dark, t } = useAppearance(book);
  const [ask, askUI] = useAsk(t);
  const overlays = useOverlays(props.initialSync);
  const [side, setSide] = useState(!mobile);
  const [nativeChrome, setNativeChrome] = useState(false);
  const [coverTools, setCoverTools] = useState<string | null>(null);
  const [finding, setFinding] = useState<Finding>({
    page: null,
    query: "",
    requested: 0,
  });
  const photoPicker = useRef<HTMLInputElement>(null);
  const toasts = useToast();
  const search = useSearch(book, overlays.modal === "search");
  const ai = useAiPanel(book);
  const navigation = useWorkspaceNavigation(props, overlays, search, {
    nativeChrome,
  });
  const editor = useActiveEditor();
  const [rail, setRail] = useRail(book);
  const shared = useSharedItems(book, mobile, overlays.modal);
  const pageData = usePageData(book, navigation.id, navigation.page?.parent);
  const sync = useSyncStatus(
    book,
    t,
    toasts.notify,
    (removed) => {
      if (navigation.id && removed.includes(navigation.id))
        void navigation.open(null);
    },
    props.reloadBooks,
  );
  const context: WorkspaceContext = {
    book,
    t,
    ask,
    current: navigation.id,
    open: navigation.open,
    show: navigation.show,
    changeBook: props.changeBook,
    overlays,
    toast: toasts.setToast,
  };

  useBookEvents(book, t);
  useQuickCapture(() => overlays.setModal("capture"));
  useClipInbox(
    book,
    t,
    ask,
    toasts.setToast,
    (rowId) => void openRow(context, rowId),
  );

  return {
    ...props,
    ...pageData,
    lang,
    theme,
    dark,
    t,
    ask,
    askUI,
    overlays,
    side,
    setSide,
    nativeChrome,
    setNativeChrome,
    coverTools,
    setCoverTools,
    finding,
    setFinding,
    photoPicker,
    toasts,
    search,
    ai,
    navigation,
    editor,
    rail,
    setRail,
    shared,
    sync,
    context,
  };
}

function useWorkspaceNavigation(
  props: WorkspaceProps,
  overlays: ReturnType<typeof useOverlays>,
  search: ReturnType<typeof useSearch>,
  { nativeChrome }: { nativeChrome: boolean },
) {
  const { setModal, setPopup, setRow } = overlays;
  const { setQuery } = search;
  const leave = useCallback(() => {
    setModal(null);
    setPopup(null);
    setRow(null);
    setQuery("");
  }, [setModal, setPopup, setRow, setQuery]);

  return usePageNavigation({
    book: props.book,
    mobile: props.mobile,
    nativeChrome,
    leave,
  });
}

function usePageData(
  book: Notebook,
  current: string | null,
  parent: string | null | undefined,
) {
  const { links, database } = usePageLinks(book, current, parent);
  const listed = book.pages.version;
  const all = useMemo(() => Array.from(book.pages.values()), [book, listed]);

  return {
    links,
    database,
    all,
    small: !!book.settings.get("small"),
    bookName: book.title,
  };
}

export type WorkspaceModel = ReturnType<typeof useWorkspaceModel>;

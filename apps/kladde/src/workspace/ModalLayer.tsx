import { Suspense } from "react";
import type { Entry, Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Ask } from "../ui/dialog";
import { Panel } from "../ui/dialog";
import type { NoteBlock } from "../capture/Recorder";
import { SyncPanel } from "../sync/SyncPanel";
import {
  Capture,
  HistoryPanel,
  PrivacyPolicy,
  Recorder,
  Transfer,
  WebClipper,
} from "./lazyParts";
import { SearchPalette, type PaletteActions } from "./SearchPalette";
import { TrashPanel } from "./Palettes";
import { SettingsPanel, type SettingsActions } from "./SettingsPanel";
import type { Search } from "./useSearch";
import type { Sync } from "./useSyncStatus";
import type { Modal } from "./types";

export interface ModalActions {
  close: () => void;
  closeCapture: () => void;
  captured: (space: string, id: string, notice?: string) => void;
  insertNote: (blocks: NoteBlock[]) => void;
  notify: (text: string) => void;
  open: (target: string | null) => Promise<void>;
  changeBook: (id?: string) => Promise<void>;
  restore: (target: string) => void;
  erase: (page: Page) => void;
  palette: PaletteActions;
  settings: SettingsActions;
}

export interface ModalState {
  modal: Modal;
  book: Notebook;
  books: [string, string][];
  entry: Entry | null;
  database: Entry | null;
  all: Page[];
  search: Search;
  sync: Sync;
  shared: string[];
  photo: File | undefined;
  t: T;
  lang: string;
  theme: string;
  mobile: boolean;
  dark: boolean;
  ask: Ask;
}

function PageModal({
  state,
  actions,
}: {
  state: ModalState;
  actions: ModalActions;
}) {
  const { modal, book, entry, t, lang } = state;

  if (!entry) return null;

  return (
    <Suspense fallback={null}>
      {modal === "record" ? (
        <Recorder
          book={book}
          entry={entry}
          lang={lang}
          t={t}
          insert={actions.insertNote}
          notify={actions.notify}
          close={actions.close}
        />
      ) : (
        <HistoryPanel
          entry={entry}
          database={state.database}
          book={book}
          lang={lang}
          dark={state.dark}
          t={t}
          ask={state.ask}
          notify={actions.notify}
          close={actions.close}
        />
      )}
    </Suspense>
  );
}

function CaptureModal({
  state,
  actions,
}: {
  state: ModalState;
  actions: ModalActions;
}) {
  return (
    <Suspense fallback={null}>
      <Capture
        book={state.book}
        books={state.books}
        shared={state.shared}
        voice={state.modal === "voice"}
        photo={state.photo}
        mobile={state.mobile}
        t={state.t}
        close={actions.closeCapture}
        saved={actions.captured}
      />
    </Suspense>
  );
}

function ToolModal({
  state,
  actions,
}: {
  state: ModalState;
  actions: ModalActions;
}) {
  const { modal, book, t, ask } = state;

  if (modal === "privacy")
    return (
      <Panel title={t("privacyPolicy")} t={t} close={actions.close}>
        <Suspense fallback={null}>
          <PrivacyPolicy lang={state.lang} />
        </Suspense>
      </Panel>
    );
  if (modal === "clipper")
    return (
      <Panel title={t("webClipper")} t={t} close={actions.close}>
        <Suspense fallback={null}>
          <WebClipper t={t} mobile={state.mobile} />
        </Suspense>
      </Panel>
    );
  if (modal === "sync")
    return (
      <Panel title={t("sync")} t={t} close={actions.close}>
        <SyncPanel
          book={book}
          ask={ask}
          t={t}
          status={state.sync.seen}
          setStatus={state.sync.setStatus}
          changeBook={actions.changeBook}
        />
      </Panel>
    );

  return (
    <Panel
      title={t("transfer")}
      t={t}
      close={actions.close}
      className="transferpanel"
    >
      <Suspense fallback={null}>
        <Transfer
          book={book}
          t={t}
          ask={ask}
          open={actions.open}
          books={state.books}
          mobile={state.mobile}
        />
      </Suspense>
    </Panel>
  );
}

export function ModalLayer({
  state,
  actions,
}: {
  state: ModalState;
  actions: ModalActions;
}) {
  const { modal, book, t } = state;

  if (modal === "record" || modal === "history")
    return <PageModal key={modal} state={state} actions={actions} />;
  if (modal === "capture" || modal === "voice")
    return <CaptureModal state={state} actions={actions} />;
  if (
    modal === "clipper" ||
    modal === "privacy" ||
    modal === "sync" ||
    modal === "transfer"
  )
    return <ToolModal key={modal} state={state} actions={actions} />;
  if (modal === "search")
    return (
      <SearchPalette
        book={book}
        all={state.all}
        search={state.search}
        t={t}
        mobile={state.mobile}
        actions={actions.palette}
      />
    );
  if (modal === "trash")
    return (
      <TrashPanel
        book={book}
        t={t}
        restore={actions.restore}
        erase={actions.erase}
        close={actions.close}
      />
    );
  if (modal === "settings")
    return (
      <SettingsPanel
        book={book}
        entry={state.entry}
        t={t}
        lang={state.lang}
        theme={state.theme}
        mobile={state.mobile}
        ask={state.ask}
        sync={state.sync.seen}
        actions={actions.settings}
      />
    );

  return null;
}

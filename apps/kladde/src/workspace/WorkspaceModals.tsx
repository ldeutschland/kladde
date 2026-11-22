import { erasePage, restorePage } from "./commands";
import { ModalLayer, type ModalActions, type ModalState } from "./ModalLayer";
import { newWorkspace } from "./pageActions";
import type { WorkspaceScope } from "./useWorkspaceViews";

export function WorkspaceModals({ workspace }: { workspace: WorkspaceScope }) {
  return (
    <ModalLayer
      state={modalStateFor(workspace)}
      actions={modalActionsFor(workspace)}
    />
  );
}

function modalStateFor(workspace: WorkspaceScope): ModalState {
  return {
    modal: workspace.overlays.modal,
    book: workspace.book,
    books: workspace.books,
    entry: workspace.navigation.entry,
    database: workspace.database,
    all: workspace.all,
    search: workspace.search,
    sync: workspace.sync,
    shared: workspace.shared,
    photo: workspace.overlays.photo,
    t: workspace.t,
    lang: workspace.lang,
    theme: workspace.theme,
    mobile: workspace.mobile,
    dark: workspace.dark,
    ask: workspace.ask,
  };
}

function modalActionsFor(workspace: WorkspaceScope): ModalActions {
  const { book, t, ask, overlays, navigation, toasts, changeBook } = workspace;

  return {
    close: () => overlays.setModal(null),
    closeCapture: overlays.closeCapture,
    captured: (space, key, notice) => {
      overlays.closeCapture();
      if (space === book.id) void navigation.open(key);
      else void changeBook(space);
      if (notice) toasts.notify(notice);
    },
    insertNote: workspace.editor.insertNote,
    notify: toasts.notify,
    open: navigation.open,
    changeBook,
    restore: (target) => void restorePage(book, target),
    erase: (target) => void erasePage(book, ask, t, target),
    palette: paletteActionsFor(workspace),
    settings: settingsActionsFor(workspace),
  };
}

function paletteActionsFor(workspace: WorkspaceScope): ModalActions["palette"] {
  const { setModal } = workspace.overlays;

  return {
    openFound: workspace.openFound,
    askAi: (text) => workspace.openAi("chat", text),
    createPage: workspace.quick.page,
    createDatabase: workspace.quick.database,
    settings: () => setModal("settings"),
    close: () => setModal(null),
  };
}

function settingsActionsFor(
  workspace: WorkspaceScope,
): ModalActions["settings"] {
  const { setModal } = workspace.overlays;
  const notify = workspace.toasts.notify;

  return {
    close: () => setModal(null),
    sync: () => setModal("sync"),
    ai: workspace.setupAi,
    transfer: () => setModal("transfer"),
    clipper: () => setModal("clipper"),
    privacy: () => setModal("privacy"),
    support: () => setModal("support"),
    newBook: () => void newWorkspace(workspace.context),
    open: workspace.navigation.open,
    notify,
  };
}

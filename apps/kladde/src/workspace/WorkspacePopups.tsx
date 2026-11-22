import { exportPage } from "./commands";
import {
  assignAiRole,
  duplicatePage,
  moveToTrash,
  newWorkspace,
  renamePage,
  setPageImage,
  showHistory,
  switchBook,
} from "./pageActions";
import { PopupLayer, type PopupActions } from "./PopupLayer";
import type { WorkspaceScope } from "./useWorkspaceViews";

export function WorkspacePopups({ workspace }: { workspace: WorkspaceScope }) {
  return (
    <PopupLayer
      popup={workspace.overlays.popup}
      book={workspace.book}
      books={workspace.books}
      current={workspace.navigation.id}
      t={workspace.t}
      lang={workspace.lang}
      mobile={workspace.mobile}
      shared={workspace.shared.length}
      actions={popupActionsFor(workspace)}
    />
  );
}

function popupActionsFor(workspace: WorkspaceScope): PopupActions {
  const { context, overlays } = workspace;

  return {
    close: () => overlays.setPopup(null),
    page: pageMenuActionsFor(workspace),
    add: workspace.quick,
    chooseRole: (target, role) => void assignAiRole(context, target, role),
    upload: (key, target, file) =>
      void setPageImage(context, key, target, file),
    switchBook: (target) => void switchBook(context, target),
    newBook: () => void newWorkspace(context),
  };
}

function pageMenuActionsFor(workspace: WorkspaceScope): PopupActions["page"] {
  const { book, t, context, overlays } = workspace;

  return {
    openTab: workspace.openTab,
    duplicate: (target) => void duplicatePage(context, target),
    chooseRole: () =>
      overlays.setPopup((current) => current && { ...current, kind: "ai" }),
    rename: (target) => renamePage(context, target),
    move: (target) => {
      overlays.setMoving(target);
      overlays.setPopup(null);
    },
    create: (kind, parent) => workspace.create(kind, parent),
    record: workspace.startRecording,
    history: (target) => void showHistory(context, target),
    export: (target) => {
      overlays.setPopup(null);
      void exportPage(book, t, target);
    },
    trash: (target) => void moveToTrash(context, target),
  };
}

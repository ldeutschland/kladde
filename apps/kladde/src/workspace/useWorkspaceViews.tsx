import { aiRootId } from "../ai/aiPages";
import type { QuickActions } from "./HomeView";
import { moveToTrash, moveWithUndo, setPageImage } from "./pageActions";
import { PageLists } from "./PageLists";
import { BookButton, SyncButton, TrashButton, type RailParts } from "./Sidebar";
import { usePageDrops, type PageDrops } from "./usePageDrops";
import type { WorkspaceActions } from "./workspaceActions";
import type { WorkspaceModel } from "./useWorkspaceModel";
import type { PageLink } from "./types";

export function useWorkspaceViews(
  model: WorkspaceModel,
  actions: WorkspaceActions,
) {
  const { book, t, mobile, context, toasts, overlays, navigation } = model;
  const drops = usePageDrops(book, t, {
    setImage: (key, target, file) =>
      void setPageImage(context, key, target, file),
    notify: toasts.notify,
    trash: (dropped) => void moveToTrash(context, dropped),
    openTab: actions.openTab,
    move: (dropped, parent) => void moveWithUndo(context, dropped, parent),
    importInto: actions.importInto,
  });
  const link: PageLink = {
    current: navigation.id,
    go: actions.go,
    menu: overlays.pageMenu,
  };
  const quick = quickActionsFor(model, actions);

  return {
    drops,
    link,
    quick,
    railParts: railPartsFor(model, actions, { drops, link, quick }),
    setup: editorSetupFor(model, actions),
    dbProps: {
      open: actions.showRow,
      mobile,
      t,
      ask: model.ask,
      openTab: mobile ? undefined : actions.openTab,
    },
    pagesShown: mobile && !navigation.page && navigation.tab === "pages",
  };
}

function quickActionsFor(
  model: WorkspaceModel,
  actions: WorkspaceActions,
): QuickActions {
  const { setModal } = model.overlays;

  return {
    page: () => actions.create(),
    database: () => actions.create("database"),
    capture: () => setModal("capture"),
    voice: () => setModal("voice"),
    clipWeb: actions.clipWeb,
    photo: () => model.photoPicker.current?.click(),
  };
}

function editorSetupFor(model: WorkspaceModel, actions: WorkspaceActions) {
  return {
    lang: model.lang,
    dark: model.dark,
    ai: model.ai.policy,
    setupAi: actions.setupAi,
    notify: model.toasts.notify,
    reveal: model.search.reveal,
    revealed: model.search.revealed,
    record: actions.startRecording,
  };
}

function railPartsFor(
  model: WorkspaceModel,
  actions: WorkspaceActions,
  views: { drops: PageDrops; link: PageLink; quick: QuickActions },
): RailParts {
  const { book, t, overlays, toasts, navigation } = model;
  const tree = {
    book,
    open: actions.go,
    current: navigation.id,
    t,
    create: (parent: string) => actions.create("page", parent),
    menu: (target: string, anchor: DOMRect) =>
      overlays.setPopup({ kind: "page", id: target, anchor }),
    notify: toasts.notify,
    importInto: actions.importInto,
  };

  return {
    brand: (
      <BookButton
        name={model.bookName}
        t={t}
        show={(e) => overlays.showPopup("books", book.id, e)}
      />
    ),
    lists: (
      <PageLists
        tree={tree}
        all={model.all}
        link={views.link}
        drops={views.drops}
        aiRoot={aiRootId(book)}
        create={views.quick.page}
        openAiHome={() => void actions.openAiHome()}
        openAiLibrary={() => actions.openAi("library")}
      />
    ),
    trash: (
      <TrashButton
        t={t}
        drop={views.drops.trash}
        open={() => overlays.setModal("trash")}
      />
    ),
    sync: (
      <SyncButton
        book={book}
        sync={model.sync}
        t={t}
        open={() => overlays.setModal("sync")}
      />
    ),
  };
}

export type WorkspaceViews = ReturnType<typeof useWorkspaceViews>;

export type WorkspaceScope = WorkspaceModel & WorkspaceActions & WorkspaceViews;

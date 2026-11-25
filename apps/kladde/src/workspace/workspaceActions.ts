import type { Reveal } from "../search/reveal";
import type { SearchHit } from "../search/search";
import { selectedQuery } from "../search/FindBar";
import type { AiView } from "../agentPanel/types";
import { prepareAiHome } from "../ai/aiPages";
import { clipWebPage, importPages } from "./commands";
import { createPage, moveWithUndo, openRow } from "./pageActions";
import type { WorkspaceModel } from "./useWorkspaceModel";

export function createWorkspaceActions(model: WorkspaceModel) {
  const pages = pageActionsFor(model);
  const ai = aiActionsFor(model, pages);

  return { ...pages, ...ai };
}

function pageActionsFor(model: WorkspaceModel) {
  const { book, t, ask, mobile, overlays, navigation, search, toasts } = model;
  const feedback = { open: navigation.open, toast: toasts.setToast };

  function openTab(target: string | null) {
    overlays.setPopup(null);
    if (!navigation.openInNewTab(target)) toasts.notify(t("tooManyTabs"));
  }

  function go(target: string | null, inNewTab = false) {
    if (inNewTab && !mobile) openTab(target);
    else void navigation.open(target);
  }

  function openFound(
    target: string,
    found: Omit<Reveal, "page">,
    inNewTab = false,
  ) {
    if (found.terms.length || found.file)
      search.setReveal({ page: target, ...found });
    go(target, inNewTab);
  }

  function showSearch() {
    search.setQuery("");
    overlays.setModal("search");
  }

  function findInPage() {
    const page = navigation.page;

    if (!page || page.kind === "database" || overlays.modal) return;
    const selected = selectedQuery();

    overlays.setPopup(null);
    model.setFinding((finding) => ({
      page: page.id,
      query: selected || finding.query,
      requested: finding.requested + 1,
    }));
  }

  function startRecording() {
    if (!model.editor.markRecordingSpot()) return;
    overlays.setPopup(null);
    overlays.setModal("record");
  }

  function moveTo(parent: string | null) {
    const moved = overlays.moving ? book.pages.get(overlays.moving) : undefined;

    if (!moved) return;
    overlays.setMoving(null);
    void moveWithUndo(model.context, moved, parent);
  }

  return {
    openTab,
    go,
    openFound,
    showSearch,
    findInPage,
    closeFind: () =>
      model.setFinding((finding) => ({ ...finding, page: null })),
    startRecording,
    moveTo,
    create: (kind?: "page" | "database", parent?: string | null) =>
      void createPage(model.context, kind, parent),
    showRow: (rowId: string) => void openRow(model.context, rowId),
    importInto: (files: File[], parent: string | null) =>
      void importPages(book, t, files, parent, feedback),
    clipWeb: () => void clipWebPage(book, ask, t, feedback),
  };
}

type PageActions = ReturnType<typeof pageActionsFor>;

function aiActionsFor(model: WorkspaceModel, pages: PageActions) {
  const { book, t, mobile, ai, overlays, navigation, search, toasts } = model;

  function openAi(view: AiView = "chat", prompt = "") {
    overlays.setModal(null);
    ai.show(view, prompt);
  }

  function openFromAi(target: string) {
    const linked = book.pages.get(target);

    if (!linked) return toasts.notify(t("pageNotApplied"));
    if (linked.archived || linked.kind === "chat")
      return toasts.notify(t("pageUnavailable"));
    if (mobile) ai.close();
    if (linked.kind === "row") pages.showRow(target);
    else void navigation.open(target);
  }

  function openSource(hit: SearchHit) {
    const source = book.pages.get(hit.doc);
    const quote = hit.matched || hit.snippet;

    if (source && !source.archived && quote)
      search.setReveal({
        page: hit.doc,
        terms: hit.file ? [] : [quote],
        file: hit.file ?? undefined,
        index: hit.page,
        found: quote,
      });
    openFromAi(hit.doc);
  }

  async function openAiHome() {
    try {
      pages.go(await prepareAiHome(book, t));
    } catch (error) {
      toasts.notify(String(error));
    }
  }

  return {
    openAi,
    toggleAi: () => (ai.open ? ai.close() : openAi()),
    openFromAi,
    openSource,
    openAiHome,
    setupAi: () => openAi("settings"),
  };
}

export type WorkspaceActions = ReturnType<typeof createWorkspaceActions>;

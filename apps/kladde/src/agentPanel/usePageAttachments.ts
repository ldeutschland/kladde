import { useState } from "react";
import type { Notebook, Page } from "../notebook/notebook";
import { ATTACHED_PAGES } from "../ai/AgentRun";
import { exclusionChecker } from "../ai/aiPages";
import type { ComposerDraft } from "./useComposerDraft";

const PICKER_RESULTS = 8;

function pickablePages(book: Notebook, attached: string[], query: string) {
  const needle = query.trim().toLowerCase();
  const hiddenFromAi = exclusionChecker(book.pages);
  const pickable = (page: Page) =>
    !page.archived &&
    page.kind !== "chat" &&
    page.kind !== "workspace" &&
    !attached.includes(page.id) &&
    page.title.toLowerCase().includes(needle) &&
    !hiddenFromAi(page.id);

  return [...book.pages.values()]
    .filter(pickable)
    .sort((a, b) => book.editedAt(b) - book.editedAt(a))
    .slice(0, PICKER_RESULTS);
}

export function usePageAttachments(book: Notebook, composer: ComposerDraft) {
  const [attached, setAttached] = useState<string[]>([]),
    [picking, setPicking] = useState(false),
    [pickQuery, setPickQuery] = useState("");

  function closePicker() {
    setPicking(false);
    setPickQuery("");
    composer.focus();
  }

  function attachPage(id: string) {
    setAttached((list) =>
      list.includes(id) ? list : [...list, id].slice(0, ATTACHED_PAGES),
    );
    closePicker();
  }

  function typeDraft(field: HTMLTextAreaElement) {
    const value = field.value,
      caret = field.selectionStart ?? value.length,
      before = value.slice(0, caret);
    const mention =
      value.length === composer.draft.length + 1 &&
      /(^|\s)@$/.test(before) &&
      attached.length < ATTACHED_PAGES;

    if (!mention) {
      composer.setDraft(value);

      return;
    }

    composer.setDraft(before.slice(0, -1) + value.slice(caret));
    setPicking(true);
  }

  return {
    attached,
    setAttached,
    clear: () => setAttached([]),
    detach: (id: string) =>
      setAttached((list) => list.filter((key) => key !== id)),
    attachPage,
    typeDraft,
    picking,
    setPicking,
    closePicker,
    pickQuery,
    setPickQuery,
    pickable: picking ? pickablePages(book, attached, pickQuery) : [],
  };
}

export type PageAttachments = ReturnType<typeof usePageAttachments>;

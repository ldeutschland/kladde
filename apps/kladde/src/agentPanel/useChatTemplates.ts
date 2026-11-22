import { useEffect, useState } from "react";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import {
  aiExcluded,
  migrateTemplates,
  pageRole,
  rolePages,
  type AiRole,
} from "../ai/aiPages";
import type { AiView } from "./types";

interface TemplateOptions {
  book: Notebook;
  t: T;
  setView: (view: AiView) => void;
  focus: () => void;
}

function usableTemplate(book: Notebook, id: string) {
  const template = id ? book.pages.get(id) : undefined;

  if (!template || template.archived) return undefined;
  if (pageRole(book, template) !== "template") return undefined;
  if (aiExcluded(book, template.id)) return undefined;

  return template;
}

export function useChatTemplates({ book, t, setView, focus }: TemplateOptions) {
  const [templateId, setTemplateId] = useState(""),
    [templateMenu, setTemplateMenu] = useState<DOMRect | null>(null),
    [libraryTab, setLibraryTab] = useState<AiRole>("template");

  useEffect(() => {
    void migrateTemplates(book, t);
  }, [book, t]);

  function apply(id: string, busy: boolean) {
    setTemplateMenu(null);
    if (busy) return;
    setTemplateId(id);
    setView("chat");
    requestAnimationFrame(focus);
  }

  function showLibrary(tab: AiRole) {
    setTemplateMenu(null);
    setLibraryTab(tab);
    setView("library");
  }

  return {
    templates: rolePages(book, "template"),
    active: usableTemplate(book, templateId),
    select: setTemplateId,
    clear: () => setTemplateId(""),
    apply,
    templateMenu,
    setTemplateMenu,
    libraryTab,
    setLibraryTab,
    showLibrary,
  };
}

export type ChatTemplates = ReturnType<typeof useChatTemplates>;

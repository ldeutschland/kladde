import {
  ArrowUpRight,
  Brain,
  LayoutTemplate,
  MessageSquareText,
  Plus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  AI_ROLES,
  ROLE_HINTS,
  ROLE_LABELS,
  createRolePage,
  memoryAuto,
  rolePages,
  type AiRole,
} from "../ai/aiPages";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";

export const ROLE_ICONS: Record<AiRole, LucideIcon> = {
  instructions: MessageSquareText,
  template: LayoutTemplate,
  memory: Brain,
};

export function AiLibrary({
  book,
  t,
  lang,
  tab,
  setTab,
  open,
  openHome,
  apply,
}: {
  book: Notebook;
  t: T;
  lang: string;
  tab: AiRole;
  setTab: (tab: AiRole) => void;
  open: (id: string) => void;
  openHome: () => void;
  apply: (id: string) => void;
}) {
  const pages = rolePages(book, tab);
  const Icon = ROLE_ICONS[tab];
  const add = async () => {
    const entry = await createRolePage(book, tab, t);

    open(entry.id);
  };

  return (
    <div className="aihistory ailibrary">
      <div
        className="segmented wide"
        role="radiogroup"
        aria-label={t("aiLibrary")}
      >
        {AI_ROLES.map((role) => (
          <button
            key={role}
            role="radio"
            aria-checked={tab === role}
            onClick={() => setTab(role)}
          >
            {t(ROLE_LABELS[role])}
          </button>
        ))}
      </div>
      <p className="templatehint">
        {t(ROLE_HINTS[tab])}
        {tab === "memory" &&
          " " + t(memoryAuto(book) ? "aiMemoryAutoOn" : "aiMemoryAutoOff")}
      </p>
      {!pages.length && <p className="muted">{t("empty")}</p>}
      {pages.map((page) => {
        const parent = page.parent ? book.pages.get(page.parent) : undefined;

        return (
          <div className="aihistoryitem" key={page.id}>
            <button className="grow" onClick={() => open(page.id)}>
              <Icon />
              <span className="grow">
                {page.title || t("untitled")}
                <small>
                  {parent ? (parent.title || t("untitled")) + " · " : ""}
                  {new Date(book.editedAt(page)).toLocaleDateString(lang)}
                </small>
              </span>
            </button>
            {tab === "template" && (
              <button className="uselink" onClick={() => apply(page.id)}>
                {t("use")}
              </button>
            )}
          </div>
        );
      })}
      <button className="templateadd" onClick={() => void add()}>
        <Plus />
        {t("aiNewPage")}
      </button>
      <button className="templateadd" onClick={openHome}>
        <ArrowUpRight />
        {t("aiOpenHome")}
      </button>
    </div>
  );
}

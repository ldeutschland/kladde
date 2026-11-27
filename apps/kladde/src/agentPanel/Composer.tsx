import type { RefObject } from "react";
import {
  ArrowUp,
  AtSign,
  Check,
  EyeOff,
  FileText,
  Globe,
  LayoutTemplate,
  Plus,
  Settings,
  Square,
  X,
} from "lucide-react";
import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { onDevice, type Policy } from "../ai/assistant";
import type { AiRole } from "../ai/aiPages";
import { ATTACHED_PAGES } from "../ai/AgentRun";
import { Popover, listKeys } from "../ui/dialog";
import { Select } from "../ui/Select";
import { effectiveMode, modeChoices } from "./modes";

const QUESTION_LENGTH = 8192;

export interface ComposerProps {
  book: Notebook;
  t: T;
  policy: Policy;
  mode: string;
  busy: boolean;
  draft: string;
  input: RefObject<HTMLTextAreaElement | null>;
  typeDraft: (field: HTMLTextAreaElement) => void;
  submit: () => void;
  stop: () => void;
  template: Page | undefined;
  clearTemplate: () => void;
  templates: Page[];
  templateMenu: DOMRect | null;
  setTemplateMenu: (anchor: DOMRect | null) => void;
  applyTemplate: (id: string) => void;
  showLibrary: (tab: AiRole) => void;
  openExcluded: boolean;
  pageContext: Page | undefined;
  attached: string[];
  detach: (id: string) => void;
  attachPage: (id: string) => void;
  picking: boolean;
  setPicking: (picking: boolean) => void;
  closePicker: () => void;
  pickQuery: string;
  setPickQuery: (query: string) => void;
  pickable: Page[];
  webSaving: boolean;
  webError: string;
  toggleWeb: () => void;
}

function AttachedChips({ c }: { c: ComposerProps }) {
  const { book, t } = c;

  return (
    <>
      {c.attached.map((id) => (
        <span className="chip" key={id}>
          <FileText />
          <span className="grow">
            {book.pages.get(id)?.title || t("untitled")}
          </span>
          <button
            type="button"
            aria-label={t("remove")}
            onClick={() => c.detach(id)}
          >
            <X />
          </button>
        </span>
      ))}
    </>
  );
}

function ContextChips({ c }: { c: ComposerProps }) {
  const { t, template, pageContext } = c;

  return (
    <div className="aicontext">
      {template && (
        <span className="chip agentchip">
          <LayoutTemplate />
          <span className="grow">{template.title || t("untitled")}</span>
          <button
            type="button"
            aria-label={t("remove") + ": " + template.title}
            disabled={c.busy}
            onClick={c.clearTemplate}
          >
            <X />
          </button>
        </span>
      )}
      {c.openExcluded && (
        <span className="chip excludedchip" title={t("aiExcludedPage")}>
          <EyeOff />
          {t("aiExcludedChip")}
        </span>
      )}
      <AttachedChips c={c} />
      {pageContext && !c.attached.includes(pageContext.id) && (
        <button
          type="button"
          className="chip"
          onClick={() => c.attachPage(pageContext.id)}
        >
          <Plus />
          {t("active")}
        </button>
      )}
      {c.attached.length < ATTACHED_PAGES && (
        <button
          type="button"
          className="chip"
          aria-expanded={c.picking}
          onClick={() => (c.picking ? c.closePicker() : c.setPicking(true))}
        >
          <AtSign />
          {t("attachPage")}
        </button>
      )}
      <button
        type="button"
        className="chip"
        aria-haspopup="menu"
        aria-expanded={!!c.templateMenu}
        onClick={(e) =>
          c.setTemplateMenu(e.currentTarget.getBoundingClientRect())
        }
      >
        <LayoutTemplate />
        {t("aiTemplates")}
      </button>
    </div>
  );
}

function TemplateMenu({ c, anchor }: { c: ComposerProps; anchor: DOMRect }) {
  const { t, templates } = c;

  return (
    <Popover
      anchor={anchor}
      label={t("aiTemplates")}
      close={() => c.setTemplateMenu(null)}
    >
      <div className="menu" role="menu" onKeyDown={listKeys}>
        {templates.map((page, i) => (
          <button
            key={page.id}
            role="menuitem"
            autoFocus={i === 0}
            onClick={() => c.applyTemplate(page.id)}
          >
            <LayoutTemplate />
            <span className="grow">{page.title || t("untitled")}</span>
            {page.id === c.template?.id && <Check />}
          </button>
        ))}
        {!templates.length && <p className="menunote">{t("templateEmpty")}</p>}
        <hr />
        <button
          role="menuitem"
          autoFocus={!templates.length}
          onClick={() => c.showLibrary("template")}
        >
          <Settings />
          {t("templateManage")}
        </button>
      </div>
    </Popover>
  );
}

function PagePicker({ c }: { c: ComposerProps }) {
  const { t, pickable } = c;

  return (
    <div className="aipicker" role="group" aria-label={t("attachPage")}>
      <input
        autoFocus
        value={c.pickQuery}
        maxLength={200}
        placeholder={t("searchPages")}
        aria-label={t("searchPages")}
        onChange={(e) => c.setPickQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            c.closePicker();
          }

          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (pickable[0]) c.attachPage(pickable[0].id);
        }}
      />
      {pickable.map((p) => (
        <button type="button" key={p.id} onClick={() => c.attachPage(p.id)}>
          <FileText />
          <span className="grow">{p.title || t("untitled")}</span>
        </button>
      ))}
      {!pickable.length && <small>{t("noResults")}</small>}
    </div>
  );
}

function WebToggle({ c }: { c: ComposerProps }) {
  const { t, policy } = c;

  return (
    <button
      type="button"
      className="webtoggle"
      aria-pressed={policy.web_search}
      disabled={c.webSaving}
      onClick={c.toggleWeb}
      title={t("webSearchHint")}
    >
      <Globe /> {t("webSearch")} {policy.web_search && <Check />}
    </button>
  );
}

function ComposerBar({ c }: { c: ComposerProps }) {
  const { book, t, policy } = c;
  const local = onDevice(policy);

  return (
    <div className="composerbar">
      {!local && <WebToggle c={c} />}
      <Select
        label={t("mode")}
        value={effectiveMode(c.mode, policy)}
        choices={modeChoices(t, policy)}
        change={(next) => book.settings.set("agentMode", next)}
      />
      <small className="grow">{local ? t("localModel") : policy.model}</small>
      {c.busy ? (
        <button
          type="button"
          className="send"
          aria-label={t("stop")}
          title={t("stop")}
          onClick={c.stop}
        >
          <Square />
        </button>
      ) : (
        <button
          className="send"
          aria-label={t("send")}
          title={t("send")}
          disabled={!c.draft.trim() || c.webSaving}
        >
          <ArrowUp />
        </button>
      )}
    </div>
  );
}

export function Composer(c: ComposerProps) {
  const { t } = c;

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        c.submit();
      }}
    >
      <ContextChips c={c} />
      {c.templateMenu && <TemplateMenu c={c} anchor={c.templateMenu} />}
      {c.picking && <PagePicker c={c} />}
      <textarea
        ref={c.input}
        rows={1}
        autoFocus
        aria-label={t("question")}
        placeholder={t("askAnything")}
        maxLength={QUESTION_LENGTH}
        value={c.draft}
        onChange={(e) => c.typeDraft(e.target)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing)
            return;
          e.preventDefault();
          c.submit();
        }}
      />
      <ComposerBar c={c} />
      {c.webError && <p role="alert">{c.webError}</p>}
      {c.policy.web_search && (
        <small className="webnotice">{t("webSearchNotice")}</small>
      )}
    </form>
  );
}

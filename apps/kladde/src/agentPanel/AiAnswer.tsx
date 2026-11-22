import {
  Check,
  Copy,
  FilePlus,
  RotateCcw,
  TextCursorInput,
} from "lucide-react";
import type { Notebook } from "../notebook/notebook";
import type { T, Word } from "../locale/locale";
import type { AgentRun } from "../ai/AgentRun";
import type { SearchHit } from "../search/search";
import type { WebSource } from "../ai/assistant";
import { linkedPage } from "../notebook/links";
import { command } from "../platform/native";
import { Markdown } from "../ui/Markdown";
import { AppliedChanges, MemoryNote, Review } from "./AnswerParts";
import type { Item } from "./types";

const stepWords: Record<string, Word> = {
  get_context: "stepContext",
  workspace_tree: "stepTree",
  search: "stepSearch",
  cite: "localSources",
  read_page: "stepRead",
  list_attachments: "stepFiles",
  read_attachment: "stepFileRead",
  inspect_database: "stepRead",
  database_guide: "stepRead",
  set_automation: "stepEdit",
  backlinks: "stepLinks",
  append_to_page: "stepEdit",
  web_search: "webSearch",
  query_database: "stepRead",
  create_page: "stepCreate",
  create_database: "stepCreate",
  edit_page: "stepEdit",
  move_page: "stepEdit",
  update_database_schema: "stepEdit",
  upsert_rows: "stepEdit",
  create_view: "stepEdit",
  archive_page: "stepArchive",
  ask_user: "stepAsk",
};

function stepLabel(step: string, t: T) {
  const space = step.indexOf(" ");
  const name = space < 0 ? step : step.slice(0, space);
  const title = space < 0 ? "" : step.slice(space + 1).trim();
  const label = Object.hasOwn(stepWords, name) ? t(stepWords[name]) : name;

  return title ? label + " · " + title : label;
}

export interface AnswerActions {
  open: (id: string) => void;
  openSource: (hit: SearchHit) => void;
  retry: () => void;
  copy: (text: string, index: number) => void;
  insert: (text: string) => void;
  saveAsPage: (text: string, question: string) => void;
  undo: (index: number) => void;
  webError: (error: string) => void;
  changed: () => void;
  applied: (run: AgentRun) => Promise<void>;
}

export interface AnswerState {
  index: number;
  question: string;
  last: boolean;
  working: boolean;
  retriable: boolean;
  copied: boolean;
  canInsert: boolean;
  locked: boolean;
  undoNote: string;
  review: AgentRun | null;
}

function resolveLink(item: Item, actions: AnswerActions) {
  return (href: string) => {
    const page = linkedPage(href);

    if (page) return () => actions.open(page);
    if (!/^source:[1-9][0-9]?$/.test(href)) return;
    const hit = item.citations?.[Number(href.slice(7)) - 1];

    if (hit) return () => actions.openSource(hit);
  };
}

function WebSources({
  sources,
  t,
  webError,
}: {
  sources: WebSource[];
  t: T;
  webError: (error: string) => void;
}) {
  return (
    <div className="websources">
      <strong>{t("webSources")}</strong>
      {sources.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            event.preventDefault();
            void command("open_web_source", {
              address: source.url,
            }).catch((error) => webError(String(error)));
          }}
        >
          {source.title} <small>{new URL(source.url).hostname}</small>
        </a>
      ))}
    </div>
  );
}

function SharedPages({
  book,
  shared,
  t,
  open,
}: {
  book: Notebook;
  shared: string[];
  t: T;
  open: (id: string) => void;
}) {
  return (
    <details className="sharedpages">
      <summary>
        {t("sent")} · {shared.length}
      </summary>
      {shared.map((id) => {
        const p = book.pages.get(id);

        return (
          p &&
          !p.archived && (
            <button key={id} onClick={() => open(id)}>
              {p.title || t("untitled")}
            </button>
          )
        );
      })}
    </details>
  );
}

function AnswerTools({
  item,
  state,
  t,
  actions,
}: {
  item: Item;
  state: AnswerState;
  t: T;
  actions: AnswerActions;
}) {
  return (
    <div className="aiactions">
      <button
        aria-label={t("copy")}
        title={state.copied ? t("copied") : t("copy")}
        onClick={() => actions.copy(item.text, state.index)}
      >
        {state.copied ? <Check /> : <Copy />}
      </button>
      {state.canInsert && (
        <button onClick={() => actions.insert(item.text)}>
          <TextCursorInput />
          {t("insertPage")}
        </button>
      )}
      <button onClick={() => actions.saveAsPage(item.text, state.question)}>
        <FilePlus />
        {t("asPage")}
      </button>
      {state.retriable && (
        <button
          aria-label={t("retry")}
          title={t("retry")}
          onClick={actions.retry}
        >
          <RotateCcw />
        </button>
      )}
      {item.cost ? <small>${item.cost.toFixed(4)}</small> : null}
    </div>
  );
}

function AnswerSources({
  book,
  item,
  t,
  actions,
}: {
  book: Notebook;
  item: Item;
  t: T;
  actions: AnswerActions;
}) {
  return (
    <>
      {!!item.citations?.length && (
        <details className="sharedpages">
          <summary>
            {t("localSources")} · {item.citations.length}
          </summary>
          {item.citations.map((hit, i) => (
            <button key={i} onClick={() => actions.openSource(hit)}>
              {i + 1}. {hit.name} · „{hit.snippet}“
            </button>
          ))}
        </details>
      )}
      {!!item.sources?.length && (
        <WebSources sources={item.sources} t={t} webError={actions.webError} />
      )}
      {!!item.shared?.length && (
        <SharedPages
          book={book}
          shared={item.shared}
          t={t}
          open={actions.open}
        />
      )}
    </>
  );
}

export function AiAnswer({
  book,
  item,
  state,
  t,
  actions,
}: {
  book: Notebook;
  item: Item;
  state: AnswerState;
  t: T;
  actions: AnswerActions;
}) {
  const { working, review } = state;

  return (
    <div className="aianswer">
      {item.steps && item.steps.length > 0 && (
        <ul className="aisteps">
          {item.steps.map((step, i) => (
            <li key={i}>
              <Check />
              {stepLabel(step, t)}
            </li>
          ))}
        </ul>
      )}
      {item.text && (
        <Markdown text={item.text} resolve={resolveLink(item, actions)} />
      )}
      <AnswerSources book={book} item={item} t={t} actions={actions} />
      {working && <p className="thinking">{t("thinking")}</p>}
      {item.error && (
        <p role="alert">
          {item.error}{" "}
          {state.retriable && (
            <button onClick={actions.retry}>{t("retry")}</button>
          )}
        </p>
      )}
      {!working && item.text && (
        <AnswerTools item={item} state={state} t={t} actions={actions} />
      )}
      {item.memory && (
        <MemoryNote mark={item.memory} t={t} open={actions.open} />
      )}
      {!working && !!item.changes?.length && (
        <AppliedChanges
          item={item}
          book={book}
          t={t}
          open={actions.open}
          locked={state.locked}
          note={state.undoNote}
          undo={() => actions.undo(state.index)}
        />
      )}
      {review && (
        <Review
          run={review}
          t={t}
          changed={actions.changed}
          applied={() => actions.applied(review)}
        />
      )}
    </div>
  );
}

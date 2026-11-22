import { useState } from "react";
import {
  Bookmark,
  BookmarkMinus,
  BookmarkPlus,
  ChevronLeft,
  History as HistoryIcon,
  Pencil,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Panel, type Ask } from "../ui/dialog";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { VersionChanges } from "./VersionChanges";
import { VersionPreview } from "./VersionPreview";
import { versionFacts } from "./versionFacts";
import { useVersionActions } from "./useVersionActions";
import { useVersionHistory } from "./useVersionHistory";
import {
  byDay,
  dayTitle,
  fullTime,
  timeOfDay,
  versionKey,
  type Version,
} from "./versions";

type Tab = "changes" | "preview";
const TABS: Tab[] = ["changes", "preview"];
const TAB_WORDS = { changes: "versionChanges", preview: "preview" } as const;
const CAUSE_WORDS = {
  change: "versionCauseChange",
  ai: "versionCauseAi",
  restore: "versionCauseRestore",
  file: "versionCauseFile",
} as const;

function VersionIcon({ version }: { version: Version }) {
  if (version.label) return <Bookmark />;

  return version.cause ? <ShieldCheck /> : <HistoryIcon />;
}

function VersionTags({ version, t }: { version: Version; t: T }) {
  return (
    <>
      {version.label && <span className="versionlabel">{version.label}</span>}
      {version.cause && (
        <span className="versioncause">{t(CAUSE_WORDS[version.cause])}</span>
      )}
      {version.foreign && (
        <span className="versionorigin">{t("versionForeign")}</span>
      )}
    </>
  );
}

function VersionList({
  versions,
  shown,
  lang,
  t,
  select,
  keepCurrent,
}: {
  versions: Version[] | null;
  shown: string | null;
  lang: string;
  t: T;
  select: (version: Version) => void;
  keepCurrent: () => void;
}) {
  const [namedOnly, setNamedOnly] = useState(false);
  const visible = (versions ?? []).filter((v) => !namedOnly || v.label);
  const now = Date.now();

  return (
    <nav className="versionlist" aria-label={t("history")}>
      <div className="versiontools">
        <button onClick={keepCurrent}>
          <BookmarkPlus />
          {t("versionKeep")}
        </button>
        <button
          aria-pressed={namedOnly}
          onClick={() => setNamedOnly(!namedOnly)}
        >
          <Bookmark />
          {t("versionNamedOnly")}
        </button>
      </div>
      {versions && visible.length === 0 && (
        <p className="muted">
          {t(namedOnly ? "versionNoneNamed" : "versionEmpty")}
        </p>
      )}
      {byDay(visible).map((group) => (
        <section key={group.day}>
          <h4>{dayTitle(group.day, now, lang)}</h4>
          {group.versions.map((version) => (
            <button
              key={versionKey(version)}
              className="versionitem"
              aria-pressed={shown === versionKey(version)}
              onClick={() => select(version)}
            >
              <VersionIcon version={version} />
              <time>{timeOfDay(version, lang)}</time>
              <VersionTags version={version} t={t} />
            </button>
          ))}
        </section>
      ))}
      <p className="versionhint">{t("versionRetention")}</p>
    </nav>
  );
}

function VersionHead({
  version,
  lang,
  t,
  back,
  rename,
  unname,
  remove,
}: {
  version: Version;
  lang: string;
  t: T;
  back: () => void;
  rename: () => void;
  unname: () => void;
  remove: () => void;
}) {
  const naming = t(version.label ? "rename" : "versionName");

  return (
    <header className="versionhead">
      <button className="versionback" aria-label={t("back")} onClick={back}>
        <ChevronLeft />
      </button>
      <div className="grow">
        <strong>{fullTime(version, lang)}</strong>
        <VersionTags version={version} t={t} />
      </div>
      {!version.foreign && (
        <button aria-label={naming} title={naming} onClick={rename}>
          {version.label ? <Pencil /> : <BookmarkPlus />}
        </button>
      )}
      {version.label && !version.foreign && (
        <button
          aria-label={t("versionUnname")}
          title={t("versionUnname")}
          onClick={unname}
        >
          <BookmarkMinus />
        </button>
      )}
      <button
        className="danger"
        aria-label={t("versionDelete")}
        title={t("versionDelete")}
        onClick={remove}
      >
        <Trash2 />
      </button>
    </header>
  );
}

function TabSwitch({
  tab,
  setTab,
  t,
}: {
  tab: Tab;
  setTab: (tab: Tab) => void;
  t: T;
}) {
  return (
    <div className="versiontabs" role="tablist">
      {TABS.map((name) => (
        <button
          key={name}
          role="tab"
          aria-selected={tab === name}
          onClick={() => setTab(name)}
        >
          {t(TAB_WORDS[name])}
        </button>
      ))}
    </div>
  );
}

interface HistoryProps {
  entry: Entry;
  database: Entry | null;
  book: Notebook;
  lang: string;
  dark: boolean;
  t: T;
  ask: Ask;
  notify: (text: string) => void;
  close: () => void;
}

interface DetailProps extends HistoryProps {
  history: ReturnType<typeof useVersionHistory>;
  actions: ReturnType<typeof useVersionActions>;
  tab: Tab;
  setTab: (tab: Tab) => void;
}

function VersionBody({ history, tab, ...props }: DetailProps) {
  const { entry, database, book, dark, t } = props;
  const { shown, old } = history;

  if (!shown || !old) return null;
  if (hasBlocks(entry) && tab === "preview")
    return (
      <VersionPreview
        book={book}
        old={old}
        title={shown.title}
        dark={dark}
        t={t}
      />
    );

  return (
    <VersionChanges
      entry={entry}
      old={old}
      facts={versionFacts(book, shown, old, entry, database, t)}
      book={book}
      t={t}
      guard={history.guard}
    />
  );
}

function VersionDetail(props: DetailProps) {
  const { history, actions, tab, setTab, entry, lang, t } = props;
  const { selected } = history;

  if (!selected) return null;

  return (
    <>
      <VersionHead
        version={selected}
        lang={lang}
        t={t}
        back={() => history.setShown(null)}
        rename={() => void actions.rename(selected)}
        unname={() => void actions.unname(selected)}
        remove={() => void actions.remove(selected)}
      />
      {hasBlocks(entry) && <TabSwitch tab={tab} setTab={setTab} t={t} />}
      <div className="versionbody" role="tabpanel">
        <VersionBody {...props} />
      </div>
      <footer>
        <button className="primary" onClick={() => void actions.restoreAll()}>
          {t("versionRestoreAll")}
        </button>
      </footer>
    </>
  );
}

function hasBlocks(entry: Entry) {
  return entry.kind === "page" || entry.kind === "row";
}

export function HistoryPanel(props: HistoryProps) {
  const { lang, t, close } = props;
  const history = useVersionHistory(props);
  const actions = useVersionActions(history, props);
  const [tab, setTab] = useState<Tab>("changes");
  const { selected, shown, old, picked, error } = history;
  const open = !!(selected && shown && old);

  return (
    <Panel title={t("history")} t={t} close={close} className="versions">
      <div className="versionlayout" data-open={open ? "" : undefined}>
        <VersionList
          versions={history.versions}
          shown={shown && picked}
          lang={lang}
          t={t}
          select={(version) => void history.select(version)}
          keepCurrent={() => void actions.keepCurrent()}
        />
        <section className="versiondetail">
          {error && <p role="alert">{error}</p>}
          {open ? (
            <VersionDetail
              {...props}
              history={history}
              actions={actions}
              tab={tab}
              setTab={setTab}
            />
          ) : (
            <div className="emptystate">
              <HistoryIcon aria-hidden="true" />
              <p>{t("versionPick")}</p>
            </div>
          )}
        </section>
      </div>
    </Panel>
  );
}

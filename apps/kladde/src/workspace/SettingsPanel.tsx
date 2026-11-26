import { Suspense } from "react";
import {
  ArrowLeftRight,
  BookCopy,
  ChevronRight,
  Cloud,
  LifeBuoy,
  Monitor,
  Moon,
  Plus,
  Scissors,
  ShieldCheck,
  Sparkles,
  Sun,
} from "lucide-react";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Ask } from "../ui/dialog";
import { Panel } from "../ui/dialog";
import { Select } from "../ui/Select";
import { syncLabel, type SyncStatus } from "../sync/sync";
import { DestinationSettings, Templates } from "./lazyParts";

const THEMES = [
  ["system", Monitor],
  ["light", Sun],
  ["dark", Moon],
] as const;
const BROWSER_EXTENSION = import.meta.env.VITE_KLADDE_BROWSER_EXTENSION === "1";
const LANGUAGE_CHOICES = [
  { value: "de", label: "Deutsch" },
  { value: "en", label: "English" },
];

export interface SettingsActions {
  close: () => void;
  sync: () => void;
  ai: () => void;
  transfer: () => void;
  clipper: () => void;
  privacy: () => void;
  support: () => void;
  books: () => void;
  newBook: () => void;
  open: (target: string | null) => Promise<void>;
  notify: (text: string) => void;
}

function GeneralSettings({
  book,
  t,
  lang,
  theme,
}: {
  book: Notebook;
  t: T;
  lang: string;
  theme: string;
}) {
  return (
    <>
      <h3>{t("general")}</h3>
      <label>
        {t("language")}
        <Select
          label={t("language")}
          value={lang}
          choices={LANGUAGE_CHOICES}
          change={(next) => book.settings.set("language", next)}
        />
      </label>
      <div className="settingrow">
        <span>{t("theme")}</span>
        <div className="segmented" role="radiogroup" aria-label={t("theme")}>
          {THEMES.map(([key, Icon]) => (
            <button
              key={key}
              role="radio"
              aria-checked={theme === key}
              onClick={() => book.settings.set("theme", key)}
            >
              <Icon />
              {t(key)}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function WorkspaceSettings({
  book,
  entry,
  t,
  ask,
  sync,
  actions,
}: {
  book: Notebook;
  entry: Entry | null;
  t: T;
  ask: Ask;
  sync: SyncStatus;
  actions: SettingsActions;
}) {
  return (
    <>
      <h3>{t("workspace")}</h3>
      <button onClick={actions.sync}>
        <Cloud />
        {t("sync")}
        <span className={"syncbadge " + sync.phase}>{syncLabel(sync, t)}</span>
        <ChevronRight className="trail" />
      </button>
      <button onClick={actions.ai}>
        <Sparkles />
        {t("ai")}
        <ChevronRight className="trail" />
      </button>
      <button onClick={actions.transfer}>
        <ArrowLeftRight />
        {t("transfer")}
        <ChevronRight className="trail" />
      </button>
      <Suspense fallback={null}>
        <Templates
          book={book}
          current={entry}
          ask={ask}
          t={t}
          open={actions.open}
          notify={actions.notify}
        />
      </Suspense>
      <button onClick={actions.books}>
        <BookCopy />
        {t("manageBooks")}
        <ChevronRight className="trail" />
      </button>
      <button onClick={actions.newBook}>
        <Plus />
        {t("newBook")}
      </button>
      <Suspense fallback={null}>
        <DestinationSettings book={book} t={t} />
      </Suspense>
    </>
  );
}

export function SettingsPanel({
  book,
  entry,
  t,
  lang,
  theme,
  mobile,
  ask,
  sync,
  actions,
}: {
  book: Notebook;
  entry: Entry | null;
  t: T;
  lang: string;
  theme: string;
  mobile: boolean;
  ask: Ask;
  sync: SyncStatus;
  actions: SettingsActions;
}) {
  return (
    <Panel
      title={t("settings")}
      t={t}
      close={actions.close}
      className="settingspanel"
    >
      <div className="settings">
        <GeneralSettings book={book} t={t} lang={lang} theme={theme} />
        <WorkspaceSettings
          book={book}
          entry={entry}
          t={t}
          ask={ask}
          sync={sync}
          actions={actions}
        />
        <h3>{t("app")}</h3>
        {(mobile || BROWSER_EXTENSION) && (
          <button onClick={actions.clipper}>
            <Scissors />
            {t("webClipper")}
            <ChevronRight className="trail" />
          </button>
        )}
        <button onClick={actions.privacy}>
          <ShieldCheck />
          {t("privacyPolicy")}
          <ChevronRight className="trail" />
        </button>
        <button onClick={actions.support}>
          <LifeBuoy />
          {t("support")}
          <ChevronRight className="trail" />
        </button>
      </div>
    </Panel>
  );
}

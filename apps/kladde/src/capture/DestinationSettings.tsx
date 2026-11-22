import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { Select } from "../ui/Select";
import {
  QUICK_NOTES,
  WEB_CLIPS,
  chooseDestination,
  destination,
  openDatabases,
  type Destination,
} from "./destinations";

const ROWS = [
  [QUICK_NOTES, "quickNotes"],
  [WEB_CLIPS, "webClips"],
] as const;

export function DestinationSettings({ book, t }: { book: Notebook; t: T }) {
  const databases = openDatabases(book)
    .map((page) => ({ value: page.id, label: page.title || t("untitled") }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const row = (key: Destination, word: (typeof ROWS)[number][1]) => {
    const current = destination(book, key);
    const fresh = {
      value: "",
      label: t("createOnFirstUse"),
    };

    return (
      <label key={key}>
        {t(word)}
        <Select
          label={t(word)}
          searchLabel={t("searchPages")}
          value={current ?? ""}
          choices={current ? databases : [fresh, ...databases]}
          change={(id) => {
            if (id) chooseDestination(book, key, id);
          }}
        />
      </label>
    );
  };

  return (
    <>
      <h3>{t("destinations")}</h3>
      <p className="settingnote">{t("destinationsInfo")}</p>
      {ROWS.map(([key, word]) => row(key, word))}
    </>
  );
}

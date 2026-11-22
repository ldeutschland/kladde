import { LayoutTemplate } from "lucide-react";
import type { Notebook, Entry } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Ask } from "../ui/dialog";
import { writeMarkdown, markdown } from "../notebook/content";

export function Templates({
  book,
  current,
  t,
  ask,
  open,
  notify,
}: {
  book: Notebook;
  current: Entry | null;
  t: T;
  ask: Ask;
  open: (id: string) => void;
  notify: (text: string) => void;
}) {
  const custom = book.manifest.doc.getMap<string>("templates");
  const builtins: [[string, string], [string, string]] = [
    [t("meeting"), t("meetingOutline")],
    [t("journal"), t("journalOutline")],
  ];
  const items = [...builtins, ...custom];

  return (
    <details className="templates">
      <summary>
        <LayoutTemplate />
        {t("template")}
      </summary>
      <div className="actionlist">
        {items.map(([name, text], index) => (
          <button
            key={index}
            onClick={async () => {
              const page = book.add(name);

              writeMarkdown(page, text);
              await book.flush();
              open(page.id);
            }}
          >
            {name}
          </button>
        ))}
        {current && (
          <button
            onClick={async () => {
              const answer = await ask(t("saveTemplate"), "", {
                placeholder: t("templateName"),
                action: t("save"),
              });
              const name = answer?.trim();

              if (!name) return;
              if (custom.size >= 64 || name.length > 120)
                throw Error("Template limit");
              const text = markdown(current);

              if (text.length > 50000) throw Error("Template too long");
              custom.set(name, text);
              notify(t("templateSaved"));
            }}
          >
            {t("saveTemplate")}
          </button>
        )}
      </div>
    </details>
  );
}

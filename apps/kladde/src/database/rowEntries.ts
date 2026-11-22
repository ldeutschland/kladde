import { type Entry, type Notebook } from "../notebook/notebook";
import { splitList } from "./compute";

export async function rowEntries(book: Notebook, db: Entry) {
  const pages = Array.from(book.pages.values()).filter(
    (p) => p.parent === db.id && p.kind === "row" && !p.archived,
  );
  const entries: Entry[] = [];

  for (const page of pages) entries.push(await book.load(page.id));

  return entries;
}

export async function renameOption(
  book: Notebook,
  db: Entry,
  fieldId: string,
  from: string,
  to: string,
) {
  for (const entry of await rowEntries(book, db)) {
    const props = entry.doc.getMap<string>("properties");
    const chosen = splitList(props.get(fieldId) ?? "");

    if (!chosen.includes(from)) continue;
    props.set(fieldId, chosen.map((v) => (v === from ? to : v)).join(","));
  }

  await book.flush();
}

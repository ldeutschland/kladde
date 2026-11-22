import { zipSync, strToU8 } from "fflate";
import type { Entry, Notebook, Page } from "../notebook/notebook";
import { markdown } from "../notebook/content";
import { computedRows } from "../database/computedRows";
import { csv } from "../database/csv";
import { fields } from "../database/fields";

const NAME_LENGTH = 120;

function safeName(title: string, id: string) {
  return (
    title.replace(/[^\p{L}\p{N} _-]/gu, "_").slice(0, NAME_LENGTH) + "-" + id
  );
}

async function pageExport(book: Notebook, page: Page, entry: Entry) {
  if (page.kind !== "database") return markdown(entry);

  return csv(
    await computedRows(book, entry),
    Array.from(fields(entry).values()),
  );
}

export async function zipNotebook(book: Notebook) {
  await book.flush();
  await book.pages.whole();
  const data: Record<string, Uint8Array<ArrayBufferLike>> = {};

  for (const page of book.pages.values()) {
    if (page.archived || page.kind === "chat") continue;
    const entry = await book.load(page.id);
    const extension = page.kind === "database" ? ".csv" : ".md";

    data[safeName(page.title, page.id) + extension] = strToU8(
      await pageExport(book, page, entry),
    );
  }

  return new Uint8Array(zipSync(data));
}

import * as Y from "yjs";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { AgentRun } from "../../src/ai/AgentRun";
import { blockEditor, blocks } from "../../src/notebook/content";
import {
  freshPage,
  type Entry,
  type Kind,
  type Notebook,
  type Page,
} from "../../src/notebook/notebook";
import type { Field } from "../../src/database/types";
import { plainText } from "./plainContent";

type Written = ReturnType<typeof blocks>;

export function writeParagraphs(entry: Entry, items: [string, string][]) {
  const written = items.map(([id, text]) => ({
    id,
    type: "paragraph" as const,
    content: text,
  })) as unknown as Written;
  const fragment = entry.doc.getXmlFragment("blocks");

  entry.doc.transact(() => {
    fragment.delete(0, fragment.length);
    blocksToYXmlFragment(blockEditor(), written, fragment);
  });
}

export function paragraphTexts(entry: Entry) {
  return blocks(entry).map((block) => plainText([block]));
}

export function blockIds(entry: Entry) {
  return blocks(entry).map((block) => block.id);
}

export function addField(database: Entry, field: Field) {
  database.doc.getMap("schema").set(field.id, field);
}

export function testSpace() {
  const pages = Object.assign(new Map<string, Page>(), {
    rowsOf: async () => {},
  });
  const entries = new Map<string, Entry>();
  const settings = new Y.Doc().getMap<unknown>("settings");
  const book = {
    id: "space",
    pages,
    settings,
    editedAt: () => 0,
    dated: (id: string) => pages.get(id),
    flush: async () => {},
    load: async (id: string) => {
      const entry = entries.get(id);

      if (!entry) throw Error("Document unavailable");

      return entry;
    },
  } as unknown as Notebook;

  function add(
    id: string,
    kind: Kind,
    parent: string | null,
    patch: Partial<Page> = {},
  ) {
    const entry: Entry = { id, kind, rev: 1, doc: new Y.Doc() };

    pages.set(id, { ...freshPage(id, id, kind, parent), ...patch });
    entries.set(id, entry);

    return entry;
  }

  return { book, pages, entries, settings, add };
}

export type TestSpace = ReturnType<typeof testSpace>;

export function startAgent(
  space: TestSpace,
  mode = "propose",
  answer: string | null = "yes",
) {
  const asked: string[] = [];
  const ask = async (question: string) => {
    asked.push(question);

    return answer;
  };

  return { run: new AgentRun(space.book, null, mode, ask, 60), asked };
}

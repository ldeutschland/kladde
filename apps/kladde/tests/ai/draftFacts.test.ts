import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { draftFacts } from "../../src/ai/draftFacts";
import { fields } from "../../src/database/fields";
import { freshPage, type Entry, type Page } from "../../src/notebook/notebook";
import type { AgentRun, Draft } from "../../src/ai/AgentRun";

function entry(
  id: string,
  kind: Entry["kind"],
  values: Record<string, string>,
) {
  const doc = new Y.Doc();
  const props = doc.getMap<string>("properties");

  for (const [key, value] of Object.entries(values)) props.set(key, value);

  return { id, kind, rev: 1, doc } as Entry;
}

function draft(live: Entry, copy: Entry, original: Page, page: Page): Draft {
  return {
    live,
    copy,
    base: new Uint8Array(),
    before: "",
    original,
    page,
    applied: false,
  };
}

describe("review facts", () => {
  it("lists title, place, trash and every changed property", () => {
    const pages = new Map<string, Page>([
      ["db", freshPage("db", "Kunden", "database", null)],
      ["folder", freshPage("folder", "Archiv", "page", null)],
      ["visible", freshPage("visible", "Ada", "row", "people")],
    ]);
    const database = entry("db", "database", {});

    fields(database).set("mail", {
      id: "mail",
      name: "E-Mail",
      type: "text",
      options: [],
    });
    fields(database).set("contact", {
      id: "contact",
      name: "Kontakt",
      type: "relation",
      options: [],
      target: "people",
    });
    const original = freshPage("row", "Alt", "row", "db");
    const page = { ...original, title: "Neu", parent: "folder", archived: 1 };
    const changes = new Map([
      ["db", { copy: database } as Draft],
      [
        "row",
        draft(
          entry("row", "row", { mail: "a@example.com", contact: "" }),
          entry("row", "row", {
            mail: "x@evil.example",
            contact: "visible,hidden",
          }),
          original,
          { ...page, parent: "db" },
        ),
      ],
    ]);
    const run = {
      changes,
      page: (id: string) => (id === "hidden" ? undefined : pages.get(id)),
    } as unknown as AgentRun;
    const facts = draftFacts(run, changes.get("row")!);

    expect(facts).toContainEqual({
      key: "title",
      word: "title",
      before: "Alt",
      after: "Neu",
    });
    expect(facts).toContainEqual({
      key: "archived",
      word: "trash",
      before: "",
      after: "✓",
    });
    expect(facts).toContainEqual({
      key: "mail",
      name: "E-Mail",
      before: "a@example.com",
      after: "x@evil.example",
    });
    expect(facts).toContainEqual({
      key: "contact",
      name: "Kontakt",
      before: "",
      after: "Ada, …",
    });
    expect(facts.some((fact) => fact.key === "parent")).toBe(false);

    const moved = draft(
      entry("row", "row", {}),
      entry("row", "row", {}),
      original,
      page,
    );

    expect(draftFacts(run, moved)).toContainEqual({
      key: "parent",
      word: "moveTo",
      before: "Kunden",
      after: "Archiv",
    });
  });
});

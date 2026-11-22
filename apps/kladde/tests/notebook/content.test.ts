import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import {
  blockEditor,
  blocks,
  restoreContent,
} from "../../src/notebook/content";
import type { Entry } from "../../src/notebook/notebook";

type Paragraphs = [string, string][];
type Written = ReturnType<typeof blocks>;

function page(doc = new Y.Doc()): Entry {
  return { id: "page", doc, rev: 1, kind: "page" };
}

function write(entry: Entry, paragraphs: Paragraphs) {
  const written = paragraphs.map(([id, text]) => ({
    id,
    type: "paragraph" as const,
    content: text,
  })) as unknown as Written;
  const fragment = entry.doc.getXmlFragment("blocks");

  entry.doc.transact(() =>
    blocksToYXmlFragment(blockEditor(), written, fragment),
  );
}

function texts(entry: Entry) {
  return blocks(entry).map((block) =>
    (block.content as { text: string }[]).map((part) => part.text).join(""),
  );
}

function copy(entry: Entry) {
  const doc = new Y.Doc();

  Y.applyUpdate(doc, Y.encodeStateAsUpdate(entry.doc));

  return page(doc);
}

function exchange(first: Entry, second: Entry) {
  const toSecond = Y.encodeStateAsUpdate(
    first.doc,
    Y.encodeStateVector(second.doc),
  );
  const toFirst = Y.encodeStateAsUpdate(
    second.doc,
    Y.encodeStateVector(first.doc),
  );

  Y.applyUpdate(second.doc, toSecond);
  Y.applyUpdate(first.doc, toFirst);
}

function typeInto(entry: Entry, index: number, text: string) {
  const paragraph = entry.doc
    .getXmlFragment("blocks")
    .toArray()[0] as Y.XmlElement;
  const container = paragraph.toArray()[index] as Y.XmlElement;
  const content = container.toArray()[0] as Y.XmlElement;
  const typed = content.toArray()[0] as Y.XmlText;

  typed.insert(typed.length, text);
}

describe("restoring a version", () => {
  it("brings back text, fields and title", () => {
    const current = page();

    write(current, [
      ["a", "Eins"],
      ["b", "Zwei"],
    ]);
    current.doc.getMap("meta").set("title", "Alt");
    current.doc.getMap("properties").set("status", "offen");
    const saved = copy(current);

    write(current, [
      ["a", "Eins"],
      ["c", "Drei"],
    ]);
    current.doc.getMap("meta").set("title", "Neu");
    current.doc.getMap("properties").set("owner", "jemand");
    restoreContent(current, saved);
    expect(texts(current)).toEqual(["Eins", "Zwei"]);
    expect(current.doc.getMap("meta").get("title")).toBe("Alt");
    expect(current.doc.getMap("properties").toJSON()).toEqual({
      status: "offen",
    });
  });

  it("keeps every attached file, also those added after the version", () => {
    const current = page();

    write(current, [["a", "Eins"]]);
    current.doc.getMap("files").set("old", { name: "alt.pdf" });
    const saved = copy(current);

    current.doc.getMap("files").set("new", { name: "neu.pdf" });
    restoreContent(current, saved);
    expect(Object.keys(current.doc.getMap("files").toJSON()).sort()).toEqual([
      "new",
      "old",
    ]);
  });

  it("leaves the row order alone", () => {
    const current = page();

    current.kind = "database";
    current.doc.getArray("row_order").push(["first"]);
    const saved = copy(current);

    current.doc.getArray("row_order").push(["second"]);
    restoreContent(current, saved);
    expect(current.doc.getArray("row_order").toArray()).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps what another device types meanwhile into an untouched block", () => {
    const here = page();

    write(here, [
      ["a", "Eins"],
      ["b", "Zwei"],
    ]);
    const saved = copy(here);

    write(here, [
      ["a", "Eins"],
      ["b", "Zwei und mehr"],
    ]);
    const there = copy(here);

    typeInto(there, 0, " und Ergänzung");
    restoreContent(here, saved);
    exchange(here, there);
    expect(texts(here)).toEqual(["Eins und Ergänzung", "Zwei"]);
    expect(texts(there)).toEqual(texts(here));
  });

  it("keeps a single document root when two devices restore at once", () => {
    const here = page();

    write(here, [
      ["a", "Eins"],
      ["b", "Zwei"],
    ]);
    const saved = copy(here);

    write(here, [
      ["a", "Eins"],
      ["b", "Zwei"],
      ["c", "Drei"],
    ]);
    const there = copy(here);

    restoreContent(here, saved);
    restoreContent(there, saved);
    exchange(here, there);
    expect(here.doc.getXmlFragment("blocks").length).toBe(1);
    expect(texts(here)).toEqual(["Eins", "Zwei"]);
  });

  it("keeps a field another device changes meanwhile when the version left it alone", () => {
    const here = page();

    here.doc.getMap("properties").set("status", "offen");
    here.doc.getMap("properties").set("owner", "A");
    const saved = copy(here);

    here.doc.getMap("properties").set("status", "erledigt");
    const there = copy(here);

    there.doc.getMap("properties").set("owner", "B");
    restoreContent(here, saved);
    exchange(here, there);
    expect(here.doc.getMap("properties").toJSON()).toEqual({
      status: "offen",
      owner: "B",
    });
  });
});

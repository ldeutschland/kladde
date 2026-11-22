import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import {
  blockEditor,
  blocks,
  restoreContent,
} from "../../src/notebook/content";
import { keepDisplacedEdits, noteEdit } from "../../src/files/fileEdits";
import type { Entry } from "../../src/notebook/notebook";

type Written = ReturnType<typeof blocks>;
type FileProps = { url: string; name: string; caption: string };

const BLOCK = "datei";
const FIRST = "geraet-a";
const SECOND = "geraet-b";
const LOCAL = "kladde-file:";

function page(doc = new Y.Doc()): Entry {
  return { id: "page", doc, rev: 1, kind: "page" };
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

function attach(entry: Entry, name: string) {
  const id = crypto.randomUUID();

  entry.doc.getMap("files").set(id, { type: "application/pdf", name, size: 1 });

  return id;
}

function write(entry: Entry, list: Written) {
  const fragment = entry.doc.getXmlFragment("blocks");

  entry.doc.transact(() => blocksToYXmlFragment(blockEditor(), list, fragment));
}

function withFile(file: string) {
  const entry = page();

  write(entry, [
    { id: "text", type: "paragraph", content: "Vertrag" },
    {
      id: BLOCK,
      type: "file",
      props: { url: LOCAL + file, name: "Vertrag.pdf", caption: "" },
    },
  ] as unknown as Written);

  return entry;
}

function changeFile(entry: Entry, id: string, change: Partial<FileProps>) {
  const list = blocks(entry);
  const block = list.find((item) => item.id === id);

  if (!block) throw Error("Block missing");
  Object.assign(block.props, change);
  write(entry, list);
}

function saveEdit(entry: Entry, device: string | null, from = BLOCK) {
  const props = fileProps(entry).find((item) => item.id === from);
  const base = props!.url.slice(LOCAL.length);
  const edited = attach(entry, "Vertrag.pdf");

  noteEdit(entry, edited, base, from, device);
  changeFile(entry, from, { url: LOCAL + edited });

  return edited;
}

function fileProps(entry: Entry) {
  return blocks(entry)
    .filter((block) => block.type === "file")
    .map((block) => {
      const { url, name, caption } = block.props as FileProps;

      return { id: block.id, url, name, caption };
    });
}

function shownFiles(entry: Entry) {
  return fileProps(entry)
    .map((props) => props.url.slice(LOCAL.length))
    .sort();
}

const ORDERS = [
  [101, 202],
  [202, 101],
];

function twoDevices([firstClient, secondClient] = ORDERS[0]) {
  const original = crypto.randomUUID();
  const first = withFile(original);

  first.doc.getMap("files").set(original, { name: "Vertrag.pdf", size: 1 });
  const second = copy(first);

  first.doc.clientID = firstClient;
  second.doc.clientID = secondClient;

  return { original, first, second };
}

describe("edits of the same file on two devices", () => {
  it.each(ORDERS)(
    "keeps both results when both devices save at once (clients %i and %i)",
    (firstClient, secondClient) => {
      const { first, second } = twoDevices([firstClient, secondClient]);
      const fromFirst = saveEdit(first, FIRST);
      const fromSecond = saveEdit(second, SECOND);

      exchange(first, second);
      const kept =
        keepDisplacedEdits(first, FIRST) + keepDisplacedEdits(second, SECOND);

      expect(kept).toBe(1);
      exchange(first, second);
      const expected = [fromFirst, fromSecond].sort();

      expect(shownFiles(first)).toEqual(expected);
      expect(shownFiles(second)).toEqual(expected);
      expect(
        keepDisplacedEdits(first, FIRST) + keepDisplacedEdits(second, SECOND),
      ).toBe(0);
    },
  );

  it("keeps a caption another device sets while the file is saved", () => {
    const { first, second } = twoDevices();
    const edited = saveEdit(first, FIRST);

    changeFile(second, BLOCK, { caption: "Unterschrieben" });
    exchange(first, second);
    expect(fileProps(first)).toEqual([
      {
        id: BLOCK,
        url: LOCAL + edited,
        name: "Vertrag.pdf",
        caption: "Unterschrieben",
      },
    ]);
  });

  it("copies the caption into the block of a displaced edit", () => {
    const { first, second } = twoDevices();

    changeFile(first, BLOCK, { caption: "Entwurf" });
    exchange(first, second);
    saveEdit(first, FIRST);
    saveEdit(second, SECOND);
    exchange(first, second);
    keepDisplacedEdits(first, FIRST);
    keepDisplacedEdits(second, SECOND);
    exchange(first, second);
    const captions = fileProps(first).map((props) => props.caption);

    expect(captions).toEqual(["Entwurf", "Entwurf"]);
  });

  it("brings nothing back after a version before the edit is restored", () => {
    const { first, second } = twoDevices();
    const before = copy(first);

    saveEdit(first, FIRST);
    exchange(first, second);
    restoreContent(second, before);
    exchange(first, second);
    expect(keepDisplacedEdits(first, FIRST)).toBe(0);
    expect(fileProps(first)).toHaveLength(1);
  });

  it("brings nothing back when the other device edited knowing the edit", () => {
    const { original, first, second } = twoDevices();

    saveEdit(first, FIRST);
    exchange(first, second);
    changeFile(second, BLOCK, { url: LOCAL + original });
    saveEdit(second, SECOND);
    exchange(first, second);
    expect(keepDisplacedEdits(first, FIRST)).toBe(0);
    expect(fileProps(first)).toHaveLength(1);
  });

  it("brings a displaced edit back only once", () => {
    const { first, second } = twoDevices();

    saveEdit(first, FIRST);
    saveEdit(second, SECOND);
    exchange(first, second);
    const firstLost = keepDisplacedEdits(first, FIRST) === 1;
    const [loser, device] = firstLost ? [first, FIRST] : [second, SECOND];

    expect(keepDisplacedEdits(loser, device)).toBe(firstLost ? 0 : 1);
    write(
      loser,
      blocks(loser).filter(
        (block) => block.type !== "file" || block.id === BLOCK,
      ),
    );
    expect(fileProps(loser)).toHaveLength(1);
    expect(keepDisplacedEdits(loser, device)).toBe(0);
    expect(fileProps(loser)).toHaveLength(1);
  });

  it.each(ORDERS)(
    "brings back the latest of several own edits (clients %i and %i)",
    (firstClient, secondClient) => {
      const { first, second } = twoDevices([firstClient, secondClient]);

      saveEdit(first, FIRST);
      const latest = saveEdit(first, FIRST);
      const other = saveEdit(second, SECOND);

      exchange(first, second);
      keepDisplacedEdits(first, FIRST);
      keepDisplacedEdits(second, SECOND);
      exchange(first, second);
      expect(shownFiles(first)).toEqual([latest, other].sort());
    },
  );

  it("never brings back an edit saved without a known device", () => {
    const { first, second } = twoDevices();

    saveEdit(first, null);
    saveEdit(second, null);
    exchange(first, second);
    expect(keepDisplacedEdits(first, FIRST)).toBe(0);
    expect(keepDisplacedEdits(second, SECOND)).toBe(0);
    expect(fileProps(first)).toHaveLength(1);
  });

  it("leaves the displaced edit of another device to that device", () => {
    const { first, second } = twoDevices();

    saveEdit(first, FIRST);
    saveEdit(second, SECOND);
    exchange(first, second);
    expect(keepDisplacedEdits(first, "geraet-c")).toBe(0);
    expect(keepDisplacedEdits(second, "geraet-c")).toBe(0);
  });

  it("ignores malformed edit records", () => {
    const { first } = twoDevices();
    const files = first.doc.getMap("files");
    const loop = crypto.randomUUID();

    files.set(loop, {
      replaces: loop,
      block: BLOCK,
      known: [],
      by: FIRST,
    });
    files.set(crypto.randomUUID(), {
      replaces: "kein-id",
      block: BLOCK,
      known: "alles",
      by: FIRST,
    });
    changeFile(first, BLOCK, { url: LOCAL + loop });
    expect(keepDisplacedEdits(first, FIRST)).toBe(0);
    expect(fileProps(first)).toHaveLength(1);
  });
});

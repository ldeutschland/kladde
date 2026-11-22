import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Entry } from "../../src/notebook/notebook";

vi.mock("../../src/platform/native", () => ({ command: vi.fn() }));

const { allVersions, applyShares, versionKey } =
  await import("../../src/versions/versions");

const FILE = "0b0f6a52-6f0e-4a4b-9c11-7d2f3e4a5b6c";
const OTHER = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function page() {
  return { id: "page", kind: "page", doc: new Y.Doc(), rev: 1 } as Entry;
}

function listed(entry: Entry) {
  return Object.fromEntries(entry.doc.getMap("versions"));
}

describe("shared versions in the page document", () => {
  it("lists own shares, follows a new name and removes retracted ones", () => {
    const entry = page();
    const own = { file: FILE, time: 100, label: "Entwurf", cause: null };

    applyShares(entry, { own: [own], gone: [] });
    expect(listed(entry)).toEqual({
      [FILE]: { time: 100, label: "Entwurf", cause: null },
    });
    applyShares(entry, { own: [{ ...own, label: "Fertig" }], gone: [] });
    expect(listed(entry)[FILE]).toMatchObject({ label: "Fertig" });
    applyShares(entry, { own: [], gone: [FILE] });
    expect(listed(entry)).toEqual({});
  });

  it("leaves the document untouched when nothing changed", () => {
    const entry = page();
    const own = { file: FILE, time: 100, label: null, cause: "file" };

    applyShares(entry, { own: [own], gone: [] });
    let updates = 0;

    entry.doc.on("update", () => updates++);
    applyShares(entry, { own: [own], gone: [] });
    expect(updates).toBe(0);
  });

  it("refuses identifiers that are no file ids", () => {
    const entry = page();
    const own = { file: "../../etc", time: 100, label: null, cause: "ai" };

    applyShares(entry, { own: [own], gone: [] });
    expect(listed(entry)).toEqual({});
  });
});

describe("the history of a page across devices", () => {
  it("shows versions of other devices next to the local ones, newest first", () => {
    const entry = page();
    const map = entry.doc.getMap("versions");

    map.set(FILE, { time: 300, label: "Vor Umbau", cause: null });
    map.set(OTHER, { time: 100, label: null, cause: "file" });
    const local = [
      { rev: 7, time: 200, label: null, cause: null },
      { rev: 3, time: 100, label: null, cause: "file" as const, file: OTHER },
    ];
    const all = allVersions(local, entry);

    expect(all.map(versionKey)).toEqual(["file:" + FILE, "rev:7", "rev:3"]);
    expect(all[0]).toMatchObject({ foreign: true, label: "Vor Umbau" });
    expect(all[2].foreign).toBeUndefined();
  });

  it("skips malformed entries and cleans what it shows", () => {
    const entry = page();
    const map = entry.doc.getMap("versions");

    map.set("kein-ident", { time: 100, label: "x", cause: null });
    map.set(OTHER, { time: "gestern", label: "x", cause: null });
    map.set(FILE, { time: 100, label: " a\nb ", cause: "sync" });
    const all = allVersions([], entry);

    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ label: "a b", cause: null, file: FILE });
  });
});

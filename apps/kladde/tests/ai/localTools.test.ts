import { describe, expect, it } from "vitest";
import type { AgentRun } from "../../src/ai/AgentRun";
import { LocalHandles } from "../../src/ai/localHandles";
import { callLocalTool } from "../../src/ai/localTools";

const ROOM = 20000;
const EXCERPT_LIMIT = 240;
const NO_MATCHES = "No matches. Try other keywords.";
const ENTRIES_HEADER = "Pages in it:";

interface FakePage {
  id: string;
  title: string;
  parent: string | null;
  text: string;
}

interface Match {
  id: string;
  title: string;
  file: string | null;
  name: string;
  snippet: string;
}

type Input = Record<string, unknown>;
type Handler = (name: string, input: Input) => unknown;

function match(id: string, title: string, snippet = ""): Match {
  return { id, title, file: null, name: "", snippet };
}

function fileMatch(id: string, title: string, file: string): Match {
  return { id, title, file, name: file + ".pdf", snippet: "" };
}

function page(
  id: string,
  title: string,
  parent: string | null,
  ...blocks: string[]
): FakePage {
  const text = blocks
    .map((block, index) => "[b:" + id + "-" + index + "] " + block)
    .join("\n");

  return { id, title, parent, text };
}

function fakeTask(pages: FakePage[], handler: Handler) {
  const book = { pages: new Map(pages.map((entry) => [entry.id, entry])) };
  const task = {
    book,
    stopped: false,
    calls: [] as [string, Input][],
    page: (id: string) => book.pages.get(id),
    call: async (name: string, input: Input) => {
      task.calls.push([name, input]);

      return handler(name, input);
    },
  };

  return task;
}

type FakeTask = ReturnType<typeof fakeTask>;

function tool(
  task: FakeTask,
  handles: LocalHandles,
  name: string,
  args: object,
) {
  return callLocalTool(
    task as unknown as AgentRun,
    handles,
    { name, arguments: JSON.stringify(args) },
    ROOM,
  );
}

function searcher(found: Map<string, Match[]>): Handler {
  return (_, input) => ({ matches: found.get(String(input.query)) ?? [] });
}

function queries(task: FakeTask) {
  return task.calls
    .filter(([name]) => name === "search")
    .map(([, input]) => input.query);
}

function search(task: FakeTask, query: string) {
  return tool(task, new LocalHandles(), "search", { query });
}

function reader(pages: FakePage[], broken = new Set<string>()): Handler {
  return (name, input) => {
    if (name === "workspace_tree")
      return pages
        .filter((entry) => entry.parent === input.parent)
        .map((entry) => ({ id: entry.id, title: entry.title }));
    if (broken.has(String(input.id))) throw Error("Page is gone");

    return pages.find((entry) => entry.id === input.id)?.text ?? "";
  };
}

async function readPage(task: FakeTask, id: string, args: object = {}) {
  const handles = new LocalHandles();

  return tool(task, handles, "read_page", { id: handles.page(id), ...args });
}

function readIds(task: FakeTask) {
  return task.calls
    .filter(([name]) => name === "read_page")
    .map(([, input]) => input.id);
}

function children(parent: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    page("c" + index, "Eintrag " + index, parent, "Inhalt " + index, "mehr"),
  );
}

describe("local search tool", () => {
  it("keeps the matches of the full query", async () => {
    const task = fakeTask(
      [],
      searcher(
        new Map([
          ["Web-Clips Zusammenfassung", [match("a", "Web-Clips", "Artikel")]],
          ["Web-Clips", [match("b", "Anderes")]],
        ]),
      ),
    );

    expect(await search(task, "Web-Clips Zusammenfassung")).toBe(
      "- [Web-Clips](kladde:p1) id p1: Artikel",
    );
    expect(queries(task)).toEqual(["Web-Clips Zusammenfassung"]);
  });

  it("searches each term on its own when the full query finds nothing", async () => {
    const task = fakeTask(
      [],
      searcher(
        new Map([
          ["Zusammenfassung", [match("a", "Wochenbericht")]],
          ["Web-Clips", [match("b", "Web-Clips"), match("a", "Wochenbericht")]],
        ]),
      ),
    );
    const output = await search(task, "Web-Clips Zusammenfassung");

    expect(queries(task)).toEqual([
      "Web-Clips Zusammenfassung",
      "Zusammenfassung",
      "Web-Clips",
    ]);
    expect(output.split("\n")).toEqual([
      "- [Wochenbericht](kladde:p1) id p1",
      "- [Web-Clips](kladde:p2) id p2",
    ]);
  });

  it("ranks pages that match more terms first", async () => {
    const task = fakeTask(
      [],
      searcher(
        new Map([
          ["Rechnung", [match("a", "Archiv")]],
          ["Strom", [match("b", "Stromvertrag")]],
          ["2026", [match("b", "Stromvertrag")]],
        ]),
      ),
    );
    const output = await search(task, "Strom Rechnung 2026");

    expect(queries(task)).toEqual([
      "Strom Rechnung 2026",
      "Rechnung",
      "Strom",
      "2026",
    ]);
    expect(output.split("\n")).toEqual([
      "- [Stromvertrag](kladde:p1) id p1",
      "- [Archiv](kladde:p2) id p2",
    ]);
  });

  it("tries at most the four longest terms", async () => {
    const task = fakeTask([], searcher(new Map()));

    expect(await search(task, "a bb ccc dddd eeeee ffffff")).toBe(NO_MATCHES);
    expect(queries(task)).toEqual([
      "a bb ccc dddd eeeee ffffff",
      "ffffff",
      "eeeee",
      "dddd",
      "ccc",
    ]);
  });

  it("does not loosen a single keyword", async () => {
    const task = fakeTask([], searcher(new Map()));

    expect(await search(task, "Zusammenfassung")).toBe(NO_MATCHES);
    expect(queries(task)).toEqual(["Zusammenfassung"]);
  });

  it("treats a result without matches as empty", async () => {
    const task = fakeTask([], () => ({}));

    expect(await search(task, "Strom Rechnung")).toBe(NO_MATCHES);
    expect(queries(task)).toEqual(["Strom Rechnung", "Rechnung", "Strom"]);
  });

  it("lists each match once and at most six of them", async () => {
    const pages = Array.from({ length: 8 }, (_, index) =>
      match("page" + index, "Seite " + index),
    );
    const task = fakeTask(
      [],
      searcher(
        new Map([
          ["Projekt", pages],
          ["Notizen", pages.slice(5)],
        ]),
      ),
    );
    const lines = (await search(task, "Projekt Notizen")).split("\n");

    expect(lines).toHaveLength(6);
    expect(lines.slice(0, 3)).toEqual([
      "- [Seite 5](kladde:p1) id p1",
      "- [Seite 6](kladde:p2) id p2",
      "- [Seite 7](kladde:p3) id p3",
    ]);
    expect(new Set(lines).size).toBe(6);
  });

  it("keeps different files of one page apart", async () => {
    const task = fakeTask(
      [],
      searcher(
        new Map([
          ["Kontoauszug", [fileMatch("a", "Bank", "mai")]],
          [
            "Bank",
            [fileMatch("a", "Bank", "juni"), fileMatch("a", "Bank", "mai")],
          ],
        ]),
      ),
    );
    const lines = (await search(task, "Bank Kontoauszug")).split("\n");

    expect(lines).toEqual([
      '- [Bank](kladde:p1) id p1 file f1 "mai.pdf"',
      '- [Bank](kladde:p1) id p1 file f2 "juni.pdf"',
    ]);
  });
});

describe("local read_page tool", () => {
  it("lists the pages inside a page after its text", async () => {
    const pages = [
      page("home", "Projekte", null, "Übersicht"),
      page("c1", "Alpha", "home", "Alpha-Text"),
      page("c2", "Beta", "home", "Beta-Text"),
    ];
    const task = fakeTask(pages, reader(pages));

    expect(await readPage(task, "home")).toBe(
      [
        "Page [Projekte](kladde:p1):",
        "Übersicht",
        ENTRIES_HEADER,
        "- [Alpha](kladde:p2) id p2",
        "- [Beta](kladde:p3) id p3",
      ].join("\n"),
    );
    expect(readIds(task)).toEqual(["home"]);
  });

  it("adds excerpts for the first four pages when the page has no text of its own", async () => {
    const pages = [page("db", "Datenbank", null), ...children("db", 6)];
    const task = fakeTask(pages, reader(pages));
    const output = await readPage(task, "db");

    expect(output.split("\n")).toEqual([
      "Page [Datenbank](kladde:p1):",
      ENTRIES_HEADER,
      "- [Eintrag 0](kladde:p2) id p2: Inhalt 0 mehr",
      "- [Eintrag 1](kladde:p3) id p3: Inhalt 1 mehr",
      "- [Eintrag 2](kladde:p4) id p4: Inhalt 2 mehr",
      "- [Eintrag 3](kladde:p5) id p5: Inhalt 3 mehr",
      "- [Eintrag 4](kladde:p6) id p6",
      "- [Eintrag 5](kladde:p7) id p7",
    ]);
    expect(readIds(task)).toEqual(["db", "c0", "c1", "c2", "c3"]);
    expect(
      task.calls
        .filter(([name]) => name === "read_page")
        .slice(1)
        .every(([, input]) => input.offset === 0),
    ).toBe(true);
  });

  it("lists at most twelve pages", async () => {
    const pages = [
      page("home", "Start", null, "Text"),
      ...children("home", 15),
    ];
    const task = fakeTask(pages, reader(pages));
    const lines = (await readPage(task, "home")).split("\n");

    expect(lines.slice(0, 3)).toEqual([
      "Page [Start](kladde:p1):",
      "Text",
      ENTRIES_HEADER,
    ]);
    expect(lines.slice(3)).toHaveLength(12);
    expect(lines.at(-1)).toBe("- [Eintrag 11](kladde:p13) id p13");
  });

  it("clips long excerpts", async () => {
    const long = "Satz ".repeat(120).trim();
    const pages = [page("db", "Liste", null), page("c1", "Lang", "db", long)];
    const task = fakeTask(pages, reader(pages));
    const lines = (await readPage(task, "db")).split("\n");
    const prefix = "- [Lang](kladde:p2) id p2: ";
    const excerpt = lines[2].slice(prefix.length);

    expect(lines[2].startsWith(prefix)).toBe(true);
    expect(excerpt).toHaveLength(EXCERPT_LIMIT);
    expect(long.startsWith(excerpt)).toBe(true);
  });

  it("does not list pages when reading on from an offset", async () => {
    const pages = [page("home", "Start", null, "Text"), ...children("home", 2)];
    const task = fakeTask(pages, reader(pages));
    const output = await readPage(task, "home", { offset: 3 });

    expect(output).not.toContain(ENTRIES_HEADER);
    expect(task.calls.map(([name]) => name)).toEqual(["read_page"]);
  });

  it("does not ask for the pages inside a page without any", async () => {
    const pages = [page("solo", "Allein", null, "Text")];
    const task = fakeTask(pages, reader(pages));

    expect(await readPage(task, "solo")).toBe(
      "Page [Allein](kladde:p1):\nText",
    );
    expect(task.calls.map(([name]) => name)).toEqual(["read_page"]);
  });

  it("calls a page without text or pages inside it empty", async () => {
    const pages = [page("leer", "Leer", null)];
    const task = fakeTask(pages, reader(pages));

    expect(await readPage(task, "leer")).toBe(
      "Page [Leer](kladde:p1):\n(empty)",
    );
  });

  it("keeps listing when one excerpt cannot be read", async () => {
    const pages = [page("db", "Datenbank", null), ...children("db", 3)];
    const task = fakeTask(pages, reader(pages, new Set(["c1"])));
    const output = await readPage(task, "db");

    expect(output.split("\n").slice(2)).toEqual([
      "- [Eintrag 0](kladde:p2) id p2: Inhalt 0 mehr",
      "- [Eintrag 1](kladde:p3) id p3",
      "- [Eintrag 2](kladde:p4) id p4: Inhalt 2 mehr",
    ]);
  });

  it("stops when the run is cancelled while it reads excerpts", async () => {
    const pages = [page("db", "Datenbank", null), ...children("db", 3)];
    const read = reader(pages);
    const task = fakeTask(pages, (name, input) => {
      if (name === "read_page" && input.id === "c0") {
        task.stopped = true;
        throw Error("Cancelled");
      }

      return read(name, input);
    });

    await expect(readPage(task, "db")).rejects.toThrow("Cancelled");
    expect(readIds(task)).toEqual(["db", "c0"]);
  });

  it("ignores malformed entries and brackets in listed titles", async () => {
    const pages = [
      page("home", "Start", null, "Text"),
      page("c1", "Kind", "home"),
    ];
    const task = fakeTask(pages, (name, input) => {
      if (name === "workspace_tree")
        return [
          { id: 5, title: "Zahl" },
          { title: "Ohne" },
          null,
          "c1",
          { id: "c1", title: "Kind](kladde:p9) [x" },
        ];

      return reader(pages)(name, input);
    });
    const lines = (await readPage(task, "home")).split("\n");

    expect(lines.slice(2)).toEqual([
      ENTRIES_HEADER,
      "- [Kind (kladde:p9)  x](kladde:p2) id p2",
    ]);
  });
});

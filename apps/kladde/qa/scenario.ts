import * as Y from "yjs";
import { command } from "../src/platform/native";
import { Notebook, freshPage, type Stored } from "../src/notebook/notebook";
import { syncBook } from "../src/sync/sync";

declare global {
  interface Window {
    __KLADDE_TEST__: { stage: string; run: string };
  }
}
const origin = "https://127.0.0.1:17445";

async function workspace() {
  const list = await command<[string, string][]>("spaces");

  if (list.length !== 1) throw Error("Expected one test workspace");

  return Notebook.open(list[0][0]);
}

async function checkPage(book: Notebook) {
  const item = Array.from(book.pages.values()).find(
    (p) => p.title === "KLADDE_PRIVATE_NATIVE_CANARY",
  );

  if (!item) throw Error("Shared page missing");

  return book.load(item.id);
}

async function scenario(render: () => void) {
  const { stage, run } = window.__KLADDE_TEST__;
  const device = await command<string>("platform");
  const input = {
    origin,
    user: "qa-" + run,
    password: "isolated-" + run,
    action: "login",
    confirm: ["", ""],
  };

  if (stage === "register") {
    const book = await Notebook.create("Native Pair");
    const page = book.add("KLADDE_PRIVATE_NATIVE_CANARY");

    page.doc.getText("offline-test").insert(0, "Basis");
    await book.flush();
    const bytes = Array.from(
      new TextEncoder().encode("KLADDE_NATIVE_FILE_MARKER"),
    );
    const file = await command<string>("add_file", {
      space: book.id,
      doc: page.id,
      data: bytes,
    });

    page.doc.getMap("files").set(file, {
      type: "text/plain",
      name: "secret.txt",
      size: bytes.length,
    });
    const [words, a, b] = await command<[string, number, number]>("phrase");

    input.confirm = [words.split(" ")[a], words.split(" ")[b]];
    await command("connect_account", {
      space: book.id,
      input: { ...input, action: "register" },
    });
    await syncBook(book);

    return "registered";
  }

  if (stage === "login") {
    const id = await command<string>("connect_account", {
      space: crypto.randomUUID(),
      input,
    });

    await command("sync_now", { space: id });
    await checkPage(await Notebook.open(id));

    return "signed-in";
  }

  if (stage === "edit" || stage === "push" || stage === "verify") {
    const book = await workspace();
    const entry = await checkPage(book);
    const text = entry.doc.getText("offline-test");

    if (stage === "edit") {
      text.insert(text.length, " " + device);
      await book.flush();

      return "offline-saved";
    }

    await syncBook(book);
    if (stage === "push") return "uploaded";
    const result = text.toString();

    if (!result.includes("macos") || !result.includes("ios"))
      throw Error("Missing offline edit: " + result);

    return result;
  }

  if (stage === "backup") {
    const book = await workspace();
    const bytes = await command<number[]>("export_backup", {
      space: book.id,
      password: "qa-only-archive-password",
    });

    if (
      new TextDecoder()
        .decode(Uint8Array.from(bytes))
        .includes("KLADDE_NATIVE_FILE_MARKER")
    )
      throw Error("Unencrypted backup");
    localStorage.setItem("qa-last-encrypted-backup", JSON.stringify(bytes));

    return "archived";
  }

  if (stage === "restore") {
    const bytes = JSON.parse(
      localStorage.getItem("qa-last-encrypted-backup") ?? "null",
    );

    if (!Array.isArray(bytes)) throw Error("Missing test backup");
    const space = await command<string>("import_backup", {
      bytes,
      password: "qa-only-archive-password",
    });
    const book = await Notebook.open(space);
    const page = await checkPage(book);
    const id = Array.from(page.doc.getMap("files").keys())[0];
    const restored = await command<number[]>("read_file", {
      space,
      doc: page.id,
      id,
    });

    if (
      new TextDecoder().decode(Uint8Array.from(restored)) !==
      "KLADDE_NATIVE_FILE_MARKER"
    )
      throw Error("Incomplete backup");
    localStorage.removeItem("qa-last-encrypted-backup");

    return "restored-with-attachment";
  }

  if (stage === "seed") {
    const book = await Notebook.create("10.000 Seiten");
    const batch: Stored[] = [];

    for (let n = 0; n < 10000; n++) {
      const id = crypto.randomUUID(),
        title = "Testseite " + n;

      book.pages.set(id, freshPage(id, title, "page", null));
      const doc = new Y.Doc();

      doc.getMap("meta").set("title", title);
      batch.push({
        id,
        space: book.id,
        kind: "page",
        title,
        body: "",
        props: "{}",
        parent: null,
        archived: false,
        links: [],
        data: Array.from(Y.encodeStateAsUpdate(doc)),
        rev: 0,
      });

      if (batch.length === 500) {
        await command("save", { notes: batch });
        batch.length = 0;
      }

      doc.destroy();
    }

    await book.flush();

    return "seeded";
  }

  if (stage === "launch") {
    render();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(
          Error(
            "Notebook viewport missing: " +
              document.body.innerText.slice(0, 180),
          ),
        );
      }, 20000);
      const observer = new MutationObserver(() => {
        const heading = document.querySelector(".home h1"),
          rows = document.querySelectorAll(".treerow");

        if (
          heading?.textContent !== "10.000 Seiten" ||
          rows.length !== 100 ||
          rows[0].getBoundingClientRect().height <= 0
        )
          return;
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      });

      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });

    return "home-and-tree-laid-out";
  }

  throw Error("Unknown native test stage");
}

export async function run(render: () => void) {
  let result: string;

  try {
    result = await scenario(render);
  } catch (error) {
    result = "ERROR: " + String(error);
  }

  const url = new URL("/__kladde_acceptance__", location.href);

  url.searchParams.set("result", result);
  location.assign(url.href);
}

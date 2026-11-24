import {
  test,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

test.beforeEach(async ({ page }, info) => {
  await page.goto(onPhone(info) ? "/?iphone" : "/");
  await page.getByRole("button", { name: "Lokal starten" }).click();
  if (onPhone(info) && (await page.locator("aside").isVisible()))
    await page.locator(".brand").waitFor();
});

function onPhone(info: TestInfo) {
  return info.project.name.includes("iphone");
}

async function press(link: Locator, info: TestInfo) {
  if (onPhone(info)) await link.tap();
  else await link.click();
}

function parts(page: Page) {
  const editor = page.locator(".bn-editor[contenteditable=true]");

  return {
    editor,
    title: page.getByRole("textbox", { name: "Titel", exact: true }),
    reference: editor.locator("a.pagelink"),
    back: page.locator("header.top").getByRole("button", { name: "Zurück" }),
  };
}

async function newPage(page: Page, title: string) {
  await page
    .locator(".quick")
    .getByRole("button", { name: "Neue Seite" })
    .click();
  await parts(page).title.fill(title);
}

test("keeps a subpage reference in step with the page title", async ({
  page,
}, info) => {
  const { editor, title, reference, back } = parts(page);

  await newPage(page, "Eltern");
  await editor.click();
  await page.keyboard.type("/Unterseite");
  await expect(page.locator(".bn-suggestion-menu")).toContainText(
    "Unterseite hinzufügen",
  );
  await page.keyboard.press("Enter");
  await expect(title).toHaveValue("");
  await title.fill("Projekt");
  await back.click();
  await expect(title).toHaveValue("Eltern");
  await expect(reference).toHaveText("Projekt");
  await press(reference, info);
  await expect(title).toHaveValue("Projekt");
  await title.fill("Projekt Alpha");
  await back.click();
  await expect(title).toHaveValue("Eltern");
  await expect(reference).toHaveText("Projekt Alpha");
});

test("links an existing page from a mention", async ({ page }) => {
  const { editor, reference, back } = parts(page);

  await newPage(page, "Ziel");
  await back.click();
  await newPage(page, "Quelle");
  await editor.click();
  await page.keyboard.type("Siehe @Ziel");
  await expect(page.locator(".bn-suggestion-menu")).toContainText("Ziel");
  await page.keyboard.press("Enter");
  await page.keyboard.type("dort");
  await expect(reference).toHaveText("Ziel");
  await expect(editor).toContainText("Siehe Ziel dort");
});

test("opens web links outside the app and stays on the page", async ({
  page,
}, info) => {
  const { editor, title } = parts(page);

  await page.evaluate(() => {
    const opened: string[] = [];

    Object.assign(window, { opened });
    window.open = (url?: string | URL) => {
      opened.push(String(url));

      return null;
    };
  });
  await newPage(page, "Quellen");
  await editor.click();
  await page.keyboard.type("Mehr unter https://example.org ");
  await press(editor.locator('a[href="https://example.org"]'), info);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { opened: string[] }).opened),
    )
    .toEqual(["https://example.org/"]);
  await expect(title).toHaveValue("Quellen");
});

test("turns stored page links into references named after the page", async ({
  page,
}) => {
  const { reference } = parts(page);
  const ids = await page.evaluate(async () => {
    const { Notebook } = await import("/src/notebook/notebook.ts");
    const { writeMarkdown } = await import("/src/notebook/content.ts");
    const notes = Object.values(
      JSON.parse(localStorage.getItem("kladde-test-notes") ?? "{}"),
    ) as { id: string; kind: string }[];
    const space = notes.find((note) => note.kind === "workspace")!.id;
    const book = await Notebook.open(space);
    const target = book.add("Ziel");
    const source = book.add("Quelle");
    type Item = { type: string; props?: { page: string } };
    const asStoredLink = (blocks: { content: Item[] }[]) =>
      blocks.map((block) => ({
        ...block,
        content: block.content.map((item) =>
          item.type === "pageLink"
            ? {
                type: "link",
                href: "kladde:" + item.props!.page,
                content: [{ type: "text", text: "Ohne Titel", styles: {} }],
              }
            : item,
        ),
      }));

    writeMarkdown(
      source,
      "Alt [x](kladde:" + target.id + ") Ende",
      asStoredLink as never,
    );
    await book.flush();

    return { source: source.id, target: target.id };
  });
  const stored = () =>
    page.evaluate(async (id) => {
      const { unpack } = await import("/src/notebook/notebook.ts");
      const note = JSON.parse(
        localStorage.getItem("kladde-test-notes") ?? "{}",
      )[id];

      return {
        blocks: unpack(note.data).getXmlFragment("blocks").toString(),
        body: String(note.body),
      };
    }, ids.source);

  expect((await stored()).blocks).toContain(
    `<link href="kladde:${ids.target}">Ohne Titel</link>`,
  );
  await page.reload();
  await page
    .locator(".recents")
    .getByRole("button", { name: "Quelle" })
    .click();
  await expect(reference).toHaveText("Ziel");
  await expect
    .poll(async () => (await stored()).blocks)
    .toContain(`<pagelink page="${ids.target}"></pagelink>`);
  await expect
    .poll(async () => (await stored()).body)
    .toContain(`[Ziel](kladde:${ids.target})`);
});

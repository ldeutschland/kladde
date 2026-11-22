import { test, expect, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }, info) => {
  await page.goto(info.project.name.includes("iphone") ? "/?iphone" : "/");
  await page.getByRole("button", { name: "Lokal starten" }).click();
  await page
    .locator(".quick")
    .getByRole("button", { name: "Neue Seite" })
    .click();
  await page.locator("section.writing .bn-editor").waitFor();
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");

    canvas.width = 400;
    canvas.height = 200;
    const context = canvas.getContext("2d")!;

    context.fillStyle = "#2383e2";
    context.fillRect(0, 0, 400, 200);
    const png = await new Promise<Blob>((done) =>
      canvas.toBlob((blob) => done(blob!), "image/png"),
    );
    const files = new DataTransfer();

    files.items.add(new File([png], "Foto.png", { type: "image/png" }));
    files.items.add(
      new File([new TextEncoder().encode("%PDF-1.4\n")], "Vertrag.pdf", {
        type: "application/pdf",
      }),
    );
    document.querySelector("section.writing")!.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: files,
      }),
    );
  });
  await expect(page.locator(".pdfblock .pdfpage")).toBeVisible();
});

async function draw(page: Page, sheet: Locator) {
  const box = (await sheet.boundingBox())!;

  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 90, { steps: 6 });
  await page.mouse.up();
}

async function lastPdfEdit(page: Page) {
  return page.evaluate(async () => {
    const loaded = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => name.includes("/src/platform/test-backend.ts"));
    const { simulatedPdfEdits } = await import(
      loaded ?? "/src/platform/test-backend.ts"
    );

    return simulatedPdfEdits.at(-1) as {
      pages: { source: number; turn: number; marks: { kind: string }[] }[];
    };
  });
}

test("annotates, turns and removes PDF pages before saving a new version", async ({
  page,
}) => {
  const file = page.locator(".bn-block-content[data-content-type='file']");
  const before = await file.getAttribute("data-url");

  await page
    .locator(".pdfblock")
    .getByRole("button", { name: "Bearbeiten" })
    .click();
  const viewer = page.getByRole("dialog", { name: "Vertrag.pdf" });

  await expect(viewer.locator(".pdfsheet")).toHaveCount(3);
  await viewer.getByRole("button", { name: "Stift" }).click();
  await draw(page, viewer.locator(".pdfsheet .sheet").first());
  await viewer
    .getByRole("button", { name: "Nach rechts drehen" })
    .first()
    .click();
  await viewer.getByRole("button", { name: "Seite entfernen" }).nth(1).click();
  await expect(viewer.locator(".pdfsheet")).toHaveCount(2);
  await viewer.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    viewer.getByRole("button", { name: "Bearbeiten" }),
  ).toBeVisible();
  const edit = await lastPdfEdit(page);

  expect(edit.pages.map((p) => [p.source, p.turn])).toEqual([
    [0, 90],
    [2, 0],
  ]);
  expect(edit.pages[0].marks.map((mark) => mark.kind)).toEqual(["pen"]);
  await viewer.getByRole("button", { name: "Schließen" }).click();
  await expect(file).toHaveCount(1);
  await expect(file).toHaveAttribute("data-name", "Vertrag.pdf");
  await expect(file).toHaveAttribute("data-url", /^kladde-file:/);
  expect(await file.getAttribute("data-url")).not.toBe(before);
});

test("asks before discarding unsaved marks", async ({ page }) => {
  await page
    .locator(".pdfblock")
    .getByRole("button", { name: "Bearbeiten" })
    .click();
  const viewer = page.getByRole("dialog", { name: "Vertrag.pdf" });

  await viewer.getByRole("button", { name: "Stift" }).click();
  await draw(page, viewer.locator(".pdfsheet .sheet").first());
  await viewer.getByRole("button", { name: "Schließen" }).click();
  const ask = page.getByRole("dialog", { name: "Änderungen verwerfen?" });

  await ask.getByRole("button", { name: "Abbrechen" }).click();
  await expect(viewer.locator(".pdfsheet .mark")).toHaveCount(1);
  await viewer.getByRole("button", { name: "Schließen" }).click();
  await ask.getByRole("button", { name: "Verwerfen" }).click();
  await expect(viewer).toBeHidden();
});

test("crops and turns an image and replaces it in the block", async ({
  page,
}) => {
  const image = page.locator("[data-content-type='image'] img.bn-visual-media");

  await image.dblclick();
  const viewer = page.getByRole("dialog", { name: "Foto.png" });

  await viewer.getByRole("button", { name: "Bearbeiten" }).click();
  await viewer.getByRole("button", { name: "Zuschneiden" }).click();
  const handle = (await viewer.locator(".crophandle.e").boundingBox())!;
  const frame = (await viewer.locator(".cropbody").boundingBox())!;

  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    frame.x + frame.width * 0.75,
    handle.y + handle.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  await viewer.locator(".viewertools .primary").click();
  await viewer.getByRole("button", { name: "Nach rechts drehen" }).click();
  await viewer.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    viewer.getByRole("button", { name: "Bearbeiten" }),
  ).toBeVisible();
  const size = await image.evaluate(async (element: HTMLImageElement) => {
    await element.decode();

    return [element.naturalWidth, element.naturalHeight];
  });

  expect(size[0]).toBe(200);
  expect(size[1]).toBeGreaterThan(290);
  expect(size[1]).toBeLessThan(310);
  await expect(
    page.locator(".bn-block-content[data-content-type='image']"),
  ).toHaveAttribute("data-name", "Foto.png");
});

test("keeps a version of the page before an edited file is saved", async ({
  page,
}) => {
  await expect(page.locator("header.top").getByRole("status")).toHaveText(
    "Lokal gespeichert",
  );
  await page
    .locator(".pdfblock")
    .getByRole("button", { name: "Bearbeiten" })
    .click();
  const viewer = page.getByRole("dialog", { name: "Vertrag.pdf" });

  await viewer
    .getByRole("button", { name: "Nach rechts drehen" })
    .first()
    .click();
  await viewer.getByRole("button", { name: "Speichern", exact: true }).click();
  await viewer.getByRole("button", { name: "Schließen" }).click();
  await page
    .locator("header.top")
    .getByRole("button", { name: "Seitenaktionen" })
    .click();
  await page.getByRole("button", { name: "Verlauf" }).click();
  const history = page.getByRole("dialog", { name: "Verlauf" });

  await expect(
    history
      .locator(".versioncause", { hasText: "vor Dateibearbeitung" })
      .first(),
  ).toBeVisible();
});

async function searchFor(page: Page, query: string) {
  await expect(page.locator("header.top").getByRole("status")).toHaveText(
    "Lokal gespeichert",
  );
  await page.keyboard.press("Meta+p");
  const palette = page.getByRole("dialog", { name: "Suche" });

  await palette.getByRole("textbox").fill(query);

  return palette;
}

test("opens recognized text in a photo with the words marked", async ({
  page,
}) => {
  const palette = await searchFor(page, "Betrag");
  const hit = palette.getByRole("button", { name: /^Foto\.png/ });

  await expect(hit).toContainText("Rechnung Nr. 4711 Betrag: 120 Euro");
  await expect(hit.locator("mark")).toHaveText("Betrag");
  await hit.click();
  const viewer = page.getByRole("dialog", { name: "Foto.png" });

  await expect(viewer.locator(".foundmarks rect")).toHaveCount(1);
  await viewer.getByRole("button", { name: "Bearbeiten" }).click();
  await expect(viewer.locator(".foundmarks rect")).toHaveCount(0);
});

test("opens a PDF hit on its page with the words marked", async ({ page }) => {
  const palette = await searchFor(page, "Betrag");

  await palette.getByRole("button", { name: /^Vertrag\.pdf/ }).click();
  const viewer = page.getByRole("dialog", { name: "Vertrag.pdf" });
  const sheets = viewer.locator(".pdfsheet");

  await expect(sheets.nth(1).locator(".foundmarks rect")).toHaveCount(1);
  await expect(viewer.locator(".foundmarks rect")).toHaveCount(1);
});

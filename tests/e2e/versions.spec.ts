import { test, expect, type Page } from "@playwright/test";

test.beforeEach(async ({ page }, info) => {
  await page.goto(info.project.name.includes("iphone") ? "/?iphone" : "/");
  await page.evaluate(() => {
    localStorage.setItem("kladde-test-share-versions", "1");
    localStorage.setItem("kladde-test-version-interval", "0");
  });
  await page.getByRole("button", { name: "Lokal starten" }).click();
  await page
    .locator(".quick")
    .getByRole("button", { name: "Neue Seite" })
    .click();
  await page
    .getByRole("textbox", { name: "Titel", exact: true })
    .fill("Protokoll");
});

async function openHistory(page: Page) {
  await page
    .locator("header.top")
    .getByRole("button", { name: "Seitenaktionen" })
    .click();
  await page.getByRole("button", { name: "Verlauf" }).click();
}

async function onAnotherDevice(page: Page) {
  await page.evaluate(() => localStorage.setItem("kladde-test-versions", "{}"));
}

test("a named version reaches another device and can be restored and removed there", async ({
  page,
}) => {
  const editor = page.locator(".bn-editor[contenteditable=true]");
  const saved = page.locator("header.top").getByRole("status");
  const history = page.getByRole("dialog", { name: "Verlauf" });

  await editor.click();
  await page.keyboard.type("Treffen am Montag");
  await expect(saved).toHaveText("Lokal gespeichert");
  await openHistory(page);
  await history
    .getByRole("button", { name: "Aktuellen Stand sichern" })
    .click();
  await page.keyboard.type("Vor Umbau");
  await page.keyboard.press("Enter");
  const named = history.getByRole("button", { name: /Vor Umbau/ });

  await expect(named).toBeVisible();
  await expect(named).not.toContainText("von anderem Gerät");
  await history.getByRole("button", { name: "Schließen" }).click();
  await editor.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" und Dienstag");
  await expect(saved).toHaveText("Lokal gespeichert");

  await onAnotherDevice(page);
  await openHistory(page);
  await expect(named).toContainText("von anderem Gerät");
  await named.click();
  await history.getByRole("tab", { name: "Vorschau" }).click();
  const preview = history.locator(".versionpreview");

  await expect(preview).toContainText("Treffen am Montag");
  await expect(preview).not.toContainText("Dienstag");
  await expect(history.getByRole("button", { name: "Umbenennen" })).toHaveCount(
    0,
  );
  await history
    .getByRole("button", { name: "Diese Version wiederherstellen" })
    .click();
  await expect(history).toBeHidden();
  await expect(editor).toContainText("Treffen am Montag");
  await expect(editor).not.toContainText("Dienstag");

  await openHistory(page);
  await named.click();
  await history.getByRole("button", { name: "Version löschen" }).click();
  await page
    .getByRole("dialog", { name: "Diese Version löschen?" })
    .getByRole("button", { name: "Löschen" })
    .click();
  await expect(named).toHaveCount(0);
});

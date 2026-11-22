const HOST = "de.kladde.clipper";
const VERSION = 1;
const BADGE_MS = 4000;
const MAX_NOTE = 4000;
const WEB = /^https?:$/;
const KINDS = ["article", "page", "selection", "image", "link", "screenshot"];
const POPUP_KINDS = ["article", "page", "selection", "screenshot"];
const PAGE_KINDS = ["article", "page", "selection"];
const MENU = [
  ["article", "clipArticle", ["page"]],
  ["page", "clipPage", ["page"]],
  ["screenshot", "clipScreenshot", ["page"]],
  ["selection", "clipSelection", ["selection"]],
  ["image", "clipImage", ["image"]],
  ["link", "clipLink", ["link"]],
];
const KNOWN_ERRORS = [
  "not_set_up",
  "not_connected",
  "invalid",
  "full",
  "storage",
  "unsupported",
  "no_selection",
  "too_large",
  "no_image",
];

class ClipError extends Error {}

function text(key) {
  return chrome.i18n.getMessage(key) || key;
}

function isWeb(address) {
  try {
    return WEB.test(new URL(address).protocol);
  } catch {
    return false;
  }
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "kladde",
      title: text("name"),
      contexts: ["page", "selection", "image", "link"],
    });
    for (const [id, label, contexts] of MENU)
      chrome.contextMenus.create({
        id,
        parentId: "kladde",
        title: text(label),
        contexts,
      });
  });
}

async function run(tabId, func, args = []) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["collect.js"],
  });
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return frame?.result;
}

async function pageParts(tab, kind) {
  const result = await run(
    tab.id,
    (wanted) => globalThis.kladdeCollect.page(wanted),
    [kind],
  );
  if (!result || result.error) throw new ClipError(result?.error ?? "invalid");
  return { html: result.html, images: result.images };
}

async function imageParts(tab, source) {
  const image = await run(
    tab.id,
    (address) => globalThis.kladdeCollect.image(address),
    [source],
  );
  const target = isWeb(source) ? source : "";
  if (!image && !target) throw new ClipError("no_image");
  return { target, images: image ? [image] : [] };
}

async function screenshotParts(tab) {
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  return { images: [{ url: "", data: shot.slice(shot.indexOf(",") + 1) }] };
}

function linkParts(address) {
  if (!isWeb(address)) throw new ClipError("unsupported");
  return { target: address };
}

function parts(tab, kind, details) {
  if (PAGE_KINDS.includes(kind)) return pageParts(tab, kind);
  if (kind === "image") return imageParts(tab, details.srcUrl ?? "");
  if (kind === "link") return linkParts(details.linkUrl ?? "");
  return screenshotParts(tab);
}

async function message(tab, kind, details) {
  if (!tab?.id || !isWeb(tab.url ?? "")) throw new ClipError("unsupported");
  return {
    version: VERSION,
    kind,
    url: tab.url,
    title: (tab.title ?? "").slice(0, 1000),
    note: (details.note ?? "").slice(0, MAX_NOTE),
    ...(await parts(tab, kind, details)),
  };
}

async function deliver(payload) {
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST, payload);
    if (!reply?.ok) throw new ClipError(reply?.error ?? "storage");
  } catch (error) {
    if (error instanceof ClipError) throw error;
    throw new ClipError("not_connected");
  }
}

function errorCode(error) {
  if (error instanceof ClipError && KNOWN_ERRORS.includes(error.message))
    return error.message;
  return "unsupported";
}

async function flag(tabId, code) {
  if (!tabId) return;
  const ok = code === "ok";
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: ok ? "#2f7d4f" : "#b3261e",
  });
  await chrome.action.setBadgeText({ tabId, text: ok ? "✓" : "!" });
  await chrome.action.setTitle({
    tabId,
    title: ok ? text("saved") : text("error_" + code),
  });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    chrome.action.setTitle({ tabId, title: text("name") }).catch(() => {});
  }, BADGE_MS);
}

async function clip(tab, kind, details = {}) {
  let code = "ok";
  try {
    await deliver(await message(tab, kind, details));
  } catch (error) {
    code = errorCode(error);
  }
  await flag(tab?.id, code).catch(() => {});
  return code;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function fromPopup(sender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("popup.html")
  );
}

chrome.runtime.onInstalled.addListener(createMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (KINDS.includes(info.menuItemId)) void clip(tab, info.menuItemId, info);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "clip-article") void clip(tab, "article");
});

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (!fromPopup(sender) || !POPUP_KINDS.includes(request?.kind)) return false;
  const note = typeof request.note === "string" ? request.note : "";
  void activeTab()
    .then((tab) => clip(tab, request.kind, { note }))
    .then(respond);
  return true;
});

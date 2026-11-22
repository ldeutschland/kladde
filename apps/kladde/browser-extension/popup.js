const CLOSE_AFTER_MS = 1200;

const text = (key) => chrome.i18n.getMessage(key) || key;
const status = document.getElementById("status");
const note = document.getElementById("note");
const buttons = Array.from(document.querySelectorAll("button[data-kind]"));

function localize() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const element of document.querySelectorAll("[data-text]"))
    element.textContent = text(element.dataset.text);
  for (const element of document.querySelectorAll("[data-placeholder]"))
    element.placeholder = text(element.dataset.placeholder);
}

function show(message, state) {
  status.textContent = message;
  status.className = state;
}

function busy(active) {
  for (const button of buttons) button.disabled = active;
}

async function clip(kind) {
  busy(true);
  show(text("saving"), "");
  const code = await chrome.runtime
    .sendMessage({ kind, note: note.value })
    .catch(() => "unsupported");
  busy(false);
  if (code === "ok") {
    show(text("saved"), "ok");
    setTimeout(() => window.close(), CLOSE_AFTER_MS);
    return;
  }
  show(text("error_" + code) || text("error_unsupported"), "fail");
}

localize();
for (const button of buttons)
  button.addEventListener("click", () => void clip(button.dataset.kind));
note.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
    void clip("article");
});
note.focus();

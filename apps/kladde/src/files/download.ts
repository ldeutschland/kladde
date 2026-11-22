import { isTauri } from "@tauri-apps/api/core";
import { command, fileBase64 } from "../platform/native";

export function cleanName(name: string) {
  return name.replace(/[^\p{L}\p{N}_. ()-]/gu, "_").slice(0, 180);
}

function downloadInBrowser(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = cleanName(name);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export async function download(name: string, contents: BlobPart, mime: string) {
  const blob = new Blob([contents], { type: mime });

  if (!isTauri()) {
    downloadInBrowser(name, blob);

    return;
  }

  try {
    await command("save_download", {
      name: cleanName(name),
      data: await fileBase64(blob),
    });
  } catch {
    downloadInBrowser(name, blob);
  }
}

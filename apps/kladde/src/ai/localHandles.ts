import { pageIdOf } from "../notebook/links";

interface FileTarget {
  page: string;
  file: string;
}

export class LocalHandles {
  private pages = new Map<string, string>();
  private pageHandles = new Map<string, string>();
  private files = new Map<string, FileTarget>();
  private fileHandles = new Map<string, string>();

  page(id: string) {
    const known = this.pageHandles.get(id);

    if (known) return known;
    const handle = "p" + (this.pages.size + 1);

    this.pages.set(handle, id);
    this.pageHandles.set(id, handle);

    return handle;
  }

  file(page: string, file: string) {
    const key = page + "/" + file;
    const known = this.fileHandles.get(key);

    if (known) return known;
    const handle = "f" + (this.files.size + 1);

    this.files.set(handle, { page, file });
    this.fileHandles.set(key, handle);

    return handle;
  }

  pageId(handle: unknown) {
    if (typeof handle !== "string") return null;
    const text = handle.trim();

    return this.pages.get(text) ?? pageIdOf(text);
  }

  fileTarget(handle: unknown) {
    return typeof handle === "string"
      ? (this.files.get(handle.trim()) ?? null)
      : null;
  }
}

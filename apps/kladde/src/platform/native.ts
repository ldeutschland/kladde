import { invoke, isTauri } from "@tauri-apps/api/core";

export function fileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const url = String(reader.result);

      resolve(url.slice(url.indexOf(",") + 1));
    };

    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function command<T>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (isTauri()) return invoke<T>(name, args);

  if (import.meta.env.DEV) {
    const { mock } = await import("./test-backend");

    return mock<T>(name, args);
  }

  throw new Error("Native application required");
}

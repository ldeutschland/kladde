import { command } from "../platform/native";

export interface SharedItem {
  id: string;
  text: string;
  file?: File;
}

const MAX_HEADER_BYTES = 4096;
const MAX_SHARED_TEXT = 100000;
const TEXT_TYPES = ["text/plain", "text/uri-list"];

function acceptedFileType(type: string) {
  return (
    type === "application/pdf" ||
    type.startsWith("image/") ||
    type === "application/octet-stream"
  );
}

export async function sharedItem(id: string): Promise<SharedItem> {
  const bytes = new Uint8Array(
    await command<ArrayBuffer>("shared_item", { id }),
  );
  const separator = bytes.indexOf(0);

  if (separator <= 0 || separator > MAX_HEADER_BYTES)
    throw Error("Invalid shared item");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const { name, type } = JSON.parse(
    decoder.decode(bytes.subarray(0, separator)),
  );

  if (typeof name !== "string" || typeof type !== "string")
    throw Error("Invalid shared item");
  const data = bytes.subarray(separator + 1);

  if (TEXT_TYPES.includes(type)) {
    if (data.length > MAX_SHARED_TEXT) throw Error("Shared text too large");

    return { id, text: decoder.decode(data) };
  }

  if (!acceptedFileType(type)) throw Error("Unsupported file");

  return { id, text: "", file: new File([data], name, { type }) };
}

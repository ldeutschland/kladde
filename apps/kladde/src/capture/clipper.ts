import { command } from "../platform/native";
import { markdown, writeMarkdown } from "../notebook/content";
import { addView, fields, newField } from "../database/fields";
import { readOnlyTypes } from "../database/types";
import { validValue } from "../database/validValue";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { WEB_CLIPS, addRow, destination, fieldNamed } from "./destinations";

export interface Clip {
  url: string;
  title: string;
  site: string;
  byline: string;
  published: string;
  markdown: string;
  images: string[];
}
export interface InboundFile {
  name: string;
  mime: string;
  size: number;
  data: string;
}
interface Inbound {
  clip: Clip;
  files: (InboundFile | null)[];
}
type ImageStore = (
  row: Entry,
  address: string,
  index: number,
) => Promise<string>;
interface StoredImage {
  id: string;
  mime: string;
  size: number;
}
interface ClipTarget {
  database: string;
  url: string;
  site: string;
  author: string;
  published: string;
}
const CLIP_FIELDS = [
  ["url", "url", "url"],
  ["site", "website", "text"],
  ["author", "author", "text"],
  ["published", "published", "date"],
] as const;
const MAX_ADDRESS = 2048;
const MAX_IMAGES = 20;
const MAX_MARKDOWN = 300_000;
const MAX_NOTE_MARKDOWN = 20_000;
const MAX_ENCODED_IMAGE = Math.ceil((10 * 1024 * 1024) / 3) * 4;
const MAX_LINE = 200;
const MAX_FILE_NAME = 100;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;
const FILE_ID = /^[0-9a-f-]{36}$/;
const FILE_NAME = /^[\w.-]{1,100}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PAGE_ADDRESS = /^https?:\/\//;
const PLACEHOLDER = /!\[((?:\\.|[^\\\]\n])*)\]\(clip-image:(\d{1,2})\)/g;
const LEFTOVER_ESCAPE = /\\(["$%&',/:;=?@^])/g;
const TEXT_PROPS = ["caption", "name"];

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function plain(text: string) {
  return text.replace(LEFTOVER_ESCAPE, "$1");
}

function tidyInline(item: unknown): unknown {
  if (!isNode(item)) return item;

  if (item.type === "text" && typeof item.text === "string") {
    const code = isNode(item.styles) && item.styles.code;

    return code ? item : { ...item, text: plain(item.text) };
  }

  if (Array.isArray(item.content))
    return { ...item, content: item.content.map(tidyInline) };

  return item;
}

function tidyCell(cell: unknown) {
  return Array.isArray(cell) ? cell.map(tidyInline) : tidyInline(cell);
}

function tidyContent(content: unknown): unknown {
  if (Array.isArray(content)) return content.map(tidyInline);
  if (!isNode(content) || !Array.isArray(content.rows)) return content;
  const rows = content.rows.map((row: unknown) =>
    isNode(row) && Array.isArray(row.cells)
      ? { ...row, cells: row.cells.map(tidyCell) }
      : row,
  );

  return { ...content, rows };
}

function tidyProps(props: unknown) {
  if (!isNode(props)) return props;
  const tidy = { ...props };

  for (const key of TEXT_PROPS)
    if (typeof tidy[key] === "string") tidy[key] = plain(tidy[key]);

  return tidy;
}

function tidyBlock(block: unknown): unknown {
  if (!isNode(block) || block.type === "codeBlock") return block;

  return {
    ...block,
    props: tidyProps(block.props),
    content: tidyContent(block.content),
    children: Array.isArray(block.children)
      ? block.children.map(tidyBlock)
      : block.children,
  };
}

export function readableClip<T>(blocks: T[]): T[] {
  return blocks.map(tidyBlock) as T[];
}

function text(value: unknown, limit: number) {
  if (typeof value !== "string" || value.length > limit)
    throw Error("Invalid clip");

  return value;
}

function isWebAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_ADDRESS &&
    value.startsWith("https://")
  );
}

function isPageAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_ADDRESS &&
    PAGE_ADDRESS.test(value)
  );
}

function clipFields(
  value: unknown,
  isSource: (value: unknown) => value is string,
  isImage: (value: unknown, index: number) => boolean,
  maxMarkdown: number,
): Clip {
  if (!isNode(value) || !isSource(value.url)) throw Error("Invalid clip");
  const images: unknown[] = Array.isArray(value.images) ? value.images : [];

  if (images.length > MAX_IMAGES || !images.every(isImage))
    throw Error("Invalid clip");

  return {
    url: value.url,
    title: text(value.title, MAX_LINE),
    site: text(value.site, MAX_LINE),
    byline: text(value.byline, MAX_LINE),
    published: text(value.published, 10),
    markdown: text(value.markdown, maxMarkdown),
    images: images as string[],
  };
}

export function readClip(value: unknown): Clip {
  return clipFields(value, isWebAddress, isWebAddress, MAX_MARKDOWN);
}

function readFile(value: unknown): InboundFile | null {
  if (value === null) return null;
  if (
    !isNode(value) ||
    typeof value.name !== "string" ||
    !FILE_NAME.test(value.name) ||
    typeof value.mime !== "string" ||
    !IMAGE_TYPES.test(value.mime) ||
    !Number.isSafeInteger(value.size) ||
    typeof value.data !== "string" ||
    value.data.length > MAX_ENCODED_IMAGE ||
    !BASE64.test(value.data)
  )
    throw Error("Invalid clip");

  return {
    name: value.name,
    mime: value.mime,
    size: Number(value.size),
    data: value.data,
  };
}

export function readInbound(value: unknown): Inbound {
  if (!isNode(value) || !Array.isArray(value.files))
    throw Error("Invalid clip");
  if (value.files.length > MAX_IMAGES) throw Error("Invalid clip");
  const files = value.files.map(readFile);
  const isImage = (address: unknown, index: number) =>
    typeof address === "string" &&
    address.length <= MAX_ADDRESS &&
    (!!files[index] || isWebAddress(address));
  const clip = clipFields(
    value.clip,
    isPageAddress,
    isImage,
    MAX_MARKDOWN + MAX_NOTE_MARKDOWN,
  );

  return { clip, files };
}

function readStoredImage(value: unknown): StoredImage {
  const raw = (value ?? {}) as Record<string, unknown>;

  if (
    typeof raw.id !== "string" ||
    !FILE_ID.test(raw.id) ||
    typeof raw.mime !== "string" ||
    !IMAGE_TYPES.test(raw.mime) ||
    !Number.isSafeInteger(raw.size)
  )
    throw Error("Invalid image");

  return { id: raw.id, mime: raw.mime, size: Number(raw.size) };
}

function clipField(
  db: Entry,
  known: unknown,
  name: string,
  type: (typeof CLIP_FIELDS)[number][2],
) {
  const field = typeof known === "string" ? fields(db).get(known) : undefined;

  if (field && !readOnlyTypes.includes(field.type)) return field.id;

  return fieldNamed(db, name, type) ?? newField(db, name, type);
}

function clipTarget(db: Entry, saved: Record<string, unknown>, t: T) {
  const target: ClipTarget = {
    database: db.id,
    url: "",
    site: "",
    author: "",
    published: "",
  };

  for (const [key, word, type] of CLIP_FIELDS)
    target[key] = clipField(db, saved[key], t(word), type);

  return target;
}

function createClipDatabase(book: Notebook, t: T) {
  const db = book.add(t("webClips"), "database");
  const target = clipTarget(db, {}, t);

  newField(db, t("clipped"), "created");
  addView(db, t("table"), "table");
  book.settings.set(WEB_CLIPS, target);

  return { db, target };
}

async function clipDatabase(book: Notebook, t: T) {
  const chosen = destination(book, WEB_CLIPS);

  if (!chosen) return createClipDatabase(book, t);
  const db = await book.load(chosen);
  const saved = book.settings.get(WEB_CLIPS) as Record<string, unknown>;
  const target = clipTarget(db, saved, t);

  if (CLIP_FIELDS.some(([key]) => saved[key] !== target[key]))
    book.settings.set(WEB_CLIPS, target);

  return { db, target };
}

function setValue(
  book: Notebook,
  db: Entry,
  row: Entry,
  fieldId: string,
  raw: string,
) {
  const field = fields(db).get(fieldId);

  if (!field || !raw) return;

  try {
    row.doc.getMap("properties").set(field.id, validValue(field, raw, book));
  } catch {
    return;
  }
}

function imageName(address: string) {
  const segment = new URL(address).pathname.split("/").pop() ?? "";
  const name = segment.replace(/[^\w.-]/g, "").slice(0, MAX_FILE_NAME);

  return name || "image";
}

export async function storeImage(
  book: Notebook,
  row: Entry,
  address: string,
): Promise<string> {
  const image = readStoredImage(
    await command("clip_image", { space: book.id, doc: row.id, address }),
  );

  row.doc.getMap("files").set(image.id, {
    type: image.mime,
    name: imageName(address),
    size: image.size,
  });

  return "kladde-file:" + image.id;
}

async function storeFile(book: Notebook, row: Entry, file: InboundFile) {
  const id = await command<string>("add_file", {
    space: book.id,
    doc: row.id,
    data: file.data,
  });

  if (typeof id !== "string" || !FILE_ID.test(id)) throw Error("Invalid image");
  row.doc
    .getMap("files")
    .set(id, { type: file.mime, name: file.name, size: file.size });

  return "kladde-file:" + id;
}

async function withImages(row: Entry, clip: Clip, store: ImageStore) {
  const stored = await Promise.allSettled(
    clip.images.map((address, index) => store(row, address, index)),
  );

  return clip.markdown.replace(PLACEHOLDER, (_, alt: string, index: string) => {
    const result = stored[Number(index)];

    return result?.status === "fulfilled" ? `![${alt}](${result.value})` : "";
  });
}

export async function saveClip(
  book: Notebook,
  address: string,
  t: T,
  id?: string,
) {
  if (!address.trim() || address.length > MAX_ADDRESS)
    throw Error(t("clipInvalid"));
  const clip = readClip(await command("clip_page", { address }));

  return storeClip(
    book,
    clip,
    t,
    (row, image) => storeImage(book, row, image),
    id,
  );
}

function readOrDiscard(id: string, inbound: unknown) {
  try {
    return readInbound(inbound);
  } catch (error) {
    void command("finish_clip_inbox_item", { id }).catch(() => {});
    throw error;
  }
}

export async function importInboxItem(book: Notebook, id: string, t: T) {
  const { clip, files } = readOrDiscard(
    id,
    await command("clip_inbox_item", { id }),
  );
  const row = await storeClip(
    book,
    clip,
    t,
    (row, address, index) => {
      const file = files[index];

      return file ? storeFile(book, row, file) : storeImage(book, row, address);
    },
    id,
  );

  await command("finish_clip_inbox_item", { id });

  return row;
}

async function clipRow(book: Notebook, db: Entry, title: string, id?: string) {
  const existing = id ? book.pages.get(id) : undefined;

  if (existing && (existing.kind !== "row" || existing.parent !== db.id))
    throw Error("Invalid clip");
  if (existing && id) return book.load(id);

  return addRow(book, db, title, id);
}

async function storeClip(
  book: Notebook,
  clip: Clip,
  t: T,
  store: ImageStore,
  id?: string,
) {
  const { db, target } = await clipDatabase(book, t);
  const row = await clipRow(book, db, clip.title || clip.site || clip.url, id);

  setValue(book, db, row, target.url, clip.url);
  setValue(book, db, row, target.site, clip.site);
  setValue(book, db, row, target.author, clip.byline);
  setValue(book, db, row, target.published, clip.published);
  await book.flush();
  writeMarkdown(row, await withImages(row, clip, store), readableClip);
  row.doc.getMap("meta").set("text", markdown(row));
  await book.flush();

  return row;
}

import * as Y from "yjs";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { blockEditor, blocks, markdown } from "../notebook/content";
import type { Entry, Notebook } from "../notebook/notebook";
import { deviceOf } from "../sync/sync";

const FILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAIN_ID = /^[\w-]{1,64}$/;
const LOCAL_FILE = "kladde-file:";
const MAX_LINEAGE = 256;
const MAX_KNOWN = 1024;

interface Edit {
  id: string;
  replaces: string;
  block: string;
  known: string[];
  by: string | null;
  rescued: boolean;
  name: string;
}

type Blocks = ReturnType<typeof blocks>;

function storedFile(entry: Entry, id: string) {
  const stored: unknown = entry.doc.getMap("files").get(id);

  return stored && typeof stored === "object"
    ? (stored as Record<string, unknown>)
    : null;
}

function knownIds(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_KNOWN) return null;
  const valid = value.every((id) => typeof id === "string" && FILE_ID.test(id));

  return valid ? (value as string[]) : null;
}

function editOf(entry: Entry, id: string): Edit | null {
  const stored = storedFile(entry, id);

  if (!stored) return null;
  const { replaces, block, known, by, rescued, name } = stored;
  const listed = knownIds(known);

  if (typeof replaces !== "string" || !FILE_ID.test(replaces)) return null;
  if (typeof block !== "string" || !PLAIN_ID.test(block) || !listed)
    return null;

  return {
    id,
    replaces,
    block,
    known: listed,
    by: typeof by === "string" && PLAIN_ID.test(by) ? by : null,
    rescued: rescued === true,
    name: typeof name === "string" ? name : "",
  };
}

function edits(entry: Entry) {
  const found: Edit[] = [];

  for (const id of entry.doc.getMap("files").keys()) {
    const edit = editOf(entry, id);

    if (edit) found.push(edit);
  }

  return found;
}

function lineage(entry: Entry, start: string) {
  const chain = [start];

  while (chain.length < MAX_LINEAGE) {
    const parent = editOf(entry, chain[chain.length - 1])?.replaces;

    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
  }

  return chain;
}

function isElement(node: unknown): node is Y.XmlElement {
  return node instanceof Y.XmlElement;
}

function blockElement(entry: Entry, id: string) {
  const pending = entry.doc
    .getXmlFragment("blocks")
    .toArray()
    .filter(isElement);

  for (let element = pending.pop(); element; element = pending.pop()) {
    const container = element.nodeName === "blockContainer";

    if (container && element.getAttribute("id") === id) return element;
    pending.push(...element.toArray().filter(isElement));
  }

  return null;
}

function currentFile(entry: Entry, block: string) {
  const content = blockElement(entry, block)?.toArray().find(isElement);
  const url: unknown = content?.getAttribute("url");

  if (typeof url !== "string" || !url.startsWith(LOCAL_FILE)) return null;

  return url.slice(LOCAL_FILE.length);
}

function displaced(entry: Entry, edit: Edit, current: string) {
  const reached = lineage(entry, current);

  if (reached.includes(edit.id)) return false;
  const ancestors = new Set(lineage(entry, edit.replaces));
  const meeting = reached.findIndex((id) => ancestors.has(id));

  if (meeting < 1) return false;
  const branch = editOf(entry, reached[meeting - 1]);

  return !!branch && !branch.known.includes(edit.id);
}

function locate(list: Blocks, id: string): [Blocks, number] | null {
  for (const [index, block] of list.entries()) {
    if (block.id === id) return [list, index];
    const inner = locate(block.children as Blocks, id);

    if (inner) return inner;
  }

  return null;
}

function rescue(entry: Entry, edit: Edit) {
  const live = blocks(entry);
  const found = locate(live, edit.block);

  if (!found) return false;
  const [siblings, index] = found;
  const original = siblings[index];
  const props = { ...original.props, url: LOCAL_FILE + edit.id };
  const named = edit.name ? { ...props, name: edit.name } : props;
  const restored = {
    ...original,
    id: crypto.randomUUID(),
    props: named,
    children: [],
  } as typeof original;

  siblings.splice(index + 1, 0, restored);
  entry.doc.transact(() => {
    blocksToYXmlFragment(
      blockEditor(),
      live,
      entry.doc.getXmlFragment("blocks"),
    );
    const stored = storedFile(entry, edit.id);

    entry.doc.getMap("files").set(edit.id, { ...stored, rescued: true });
  });

  return true;
}

export function noteEdit(
  entry: Entry,
  file: string,
  base: string,
  block: string,
  device: string | null,
) {
  if (!FILE_ID.test(file) || !FILE_ID.test(base) || !PLAIN_ID.test(block))
    return;
  const stored = storedFile(entry, file);

  if (!stored) return;
  const known = edits(entry)
    .filter((edit) => edit.block === block && edit.id !== file)
    .map((edit) => edit.id)
    .slice(-MAX_KNOWN);
  const owner = device && PLAIN_ID.test(device) ? { by: device } : {};

  entry.doc
    .getMap("files")
    .set(file, { ...stored, replaces: base, block, known, ...owner });
}

export function keepDisplacedEdits(entry: Entry, device: string) {
  const all = edits(entry);
  const superseded = new Set(all.map((edit) => edit.replaces));
  let kept = 0;

  for (const edit of all) {
    if (edit.by !== device || edit.rescued || superseded.has(edit.id)) continue;
    const current = currentFile(entry, edit.block);

    if (!current || !displaced(entry, edit, current)) continue;
    if (rescue(entry, edit)) kept++;
  }

  return kept;
}

const devices = new Map<string, string>();

export async function thisDevice(book: Notebook) {
  const known = devices.get(book.id);

  if (known) return known;
  const device = await deviceOf(book.id).catch(() => null);

  if (device) devices.set(book.id, device);

  return device;
}

export async function noteSavedEdit(
  book: Notebook,
  entry: Entry,
  target: { block: string; url: string },
  file: string,
) {
  if (!target.url.startsWith(LOCAL_FILE)) return;
  const base = target.url.slice(LOCAL_FILE.length);

  noteEdit(entry, file, base, target.block, await thisDevice(book));
}

export async function keepEditsOf(book: Notebook, entry: Entry) {
  if (!entry.doc.getMap("files").size) return;
  const device = await thisDevice(book);

  if (!device || !keepDisplacedEdits(entry, device)) return;
  entry.doc.getMap("meta").set("text", markdown(entry));
}

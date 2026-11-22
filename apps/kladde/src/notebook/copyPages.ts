import { Notebook, createdAt, type Entry, type Page } from "./notebook";
import { blocks, blockEditor } from "./content";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { copyFile } from "../files/attachments";

const COPIED_MAPS = [
  "schema",
  "views",
  "automations",
  "counters",
  "properties",
  "meta",
];
const PAGE_REFERENCE = /(kladde(?:-file)?:)([0-9a-f-]{36})/g;
const ID_LIST = /^[0-9a-f-]{36}(?:,[0-9a-f-]{36})+$/;

interface CopyPlan {
  source: Notebook;
  destination: Notebook;
  root: string;
  order: Page[];
  ids: Map<string, string>;
  entries: Map<string, Entry>;
}

type Copies = Map<string, Entry>;

function replaceRefs(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") {
    if (ids.has(value)) return ids.get(value);
    if (ID_LIST.test(value))
      return value
        .split(",")
        .map((id) => ids.get(id) ?? id)
        .join(",");

    return value.replace(
      PAGE_REFERENCE,
      (_, prefix, id) => prefix + (ids.get(id) ?? id),
    );
  }

  if (Array.isArray(value)) return value.map((item) => replaceRefs(item, ids));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceRefs(item, ids)]),
    );

  return value;
}

function copyableRoot(pages: Map<string, Page>, root: string) {
  const first = pages.get(root);

  if (
    !first ||
    first.archived ||
    first.kind === "workspace" ||
    first.kind === "chat"
  )
    throw Error("Invalid page");

  return first;
}

function childrenByParent(pages: Map<string, Page>) {
  const children = new Map<string, Page[]>();

  for (const page of pages.values()) {
    if (!page.parent || page.archived) continue;
    const items = children.get(page.parent) ?? [];

    items.push(page);
    children.set(page.parent, items);
  }

  return children;
}

async function planCopy(
  source: Notebook,
  destination: Notebook,
  root: string,
): Promise<CopyPlan> {
  await source.pages.whole();
  const pages = new Map(source.pages);
  const first = copyableRoot(pages, root);
  const children = childrenByParent(pages);
  const pending = [first];
  const order: Page[] = [];
  const ids = new Map<string, string>();
  const entries = new Map<string, Entry>();

  for (let index = 0; index < pending.length; index++) {
    const page = pending[index];

    if (ids.has(page.id)) throw Error("Cyclic page tree");
    ids.set(page.id, crypto.randomUUID());
    order.push(page);
    pending.push(...(children.get(page.id) ?? []));
    entries.set(page.id, await source.load(page.id));
  }

  return { source, destination, root, order, ids, entries };
}

function copyParent({ source, destination, root, ids }: CopyPlan, page: Page) {
  if (page.id !== root) return ids.get(page.parent!)!;

  return source === destination ? page.parent : null;
}

function copyTitle({ source, destination, root }: CopyPlan, page: Page) {
  return page.id === root && source === destination
    ? page.title + " (2)"
    : page.title;
}

function createCopies(plan: CopyPlan, move: boolean): Copies {
  const { destination, order, ids } = plan;
  const created: Copies = new Map();
  const now = Date.now();

  for (const page of order) {
    const id = ids.get(page.id)!;
    const parent = copyParent(plan, page);

    created.set(page.id, destination.add(page.title, page.kind, parent, id));
    destination.pages.set(id, {
      ...page,
      id,
      parent,
      ...(move ? { created: createdAt(page) } : { created: now, updated: now }),
      title: copyTitle(plan, page),
    });
  }

  return created;
}

async function copyFiles(plan: CopyPlan, created: Copies) {
  const { source, destination, order, ids, entries } = plan;

  for (const page of order) {
    const original = entries.get(page.id)!;
    const copy = created.get(page.id)!;

    for (const file of original.doc.getMap("files").keys()) {
      const id = await copyFile(source, original, destination, copy, file);

      if (id) ids.set(file, id);
    }
  }
}

function copyMaps(original: Entry, copy: Entry, ids: Map<string, string>) {
  for (const name of COPIED_MAPS)
    for (const [key, value] of original.doc.getMap(name))
      copy.doc.getMap(name).set(key, replaceRefs(value, ids));
}

function copyRowOrder(original: Entry, copy: Entry, ids: Map<string, string>) {
  const rowIds = original.doc
    .getArray<string>("row_order")
    .toArray()
    .map((id) => ids.get(id))
    .filter((id): id is string => !!id);

  copy.doc.getArray("row_order").push(rowIds);
}

function copyBlocks(original: Entry, copy: Entry, ids: Map<string, string>) {
  const data = blocks(original);

  if (!data.length) return;
  blocksToYXmlFragment(
    blockEditor(),
    replaceRefs(data, ids) as typeof data,
    copy.doc.getXmlFragment("blocks"),
  );
}

function copyContent(plan: CopyPlan, created: Copies, rescued?: string) {
  const { destination, root, order, ids, entries } = plan;

  for (const page of order) {
    const original = entries.get(page.id)!;
    const copy = created.get(page.id)!;
    const copied = destination.pages.get(copy.id)!;

    copyMaps(original, copy, ids);
    copy.doc.getMap("meta").set("title", copied.title);
    copyRowOrder(original, copy, ids);
    copyBlocks(original, copy, ids);
    destination.pages.set(copy.id, {
      ...copied,
      icon: replaceRefs(copied.icon, ids) as string,
      cover: replaceRefs(copied.cover, ids) as string,
      ...(rescued && page.id === root ? { rescued } : {}),
    });
  }
}

async function fillCopies(plan: CopyPlan, created: Copies, rescued?: string) {
  const { destination } = plan;

  try {
    await copyFiles(plan, created);
    copyContent(plan, created, rescued);
    await destination.flush();
  } catch (error) {
    for (const copy of created.values())
      await destination.change(copy.id, { archived: Date.now() });
    await destination.flush();
    throw error;
  }
}

async function archiveOriginals({ source, order }: CopyPlan) {
  const time = Date.now();

  for (const page of order) await source.change(page.id, { archived: time });
  await source.flush();
}

export async function copyPages(
  source: Notebook,
  destination: Notebook,
  root: string,
  move: boolean,
  rescued?: string,
) {
  const plan = await planCopy(source, destination, root);
  const created = createCopies(plan, move);

  await destination.flush();
  await fillCopies(plan, created, rescued);
  if (move) await archiveOriginals(plan);

  return plan.ids.get(root)!;
}

import * as Y from "yjs";
import {
  Notebook,
  freshPage,
  type Entry,
  type Page,
} from "../notebook/notebook";
import type { SearchHit } from "../search/search";
import { markdown } from "../notebook/content";
import { fields, views } from "../database/fields";
import { automations, counters, numberRows } from "../database/rules";
import { aiProtected, sharingChecker } from "./aiPages";
import type { Ask } from "../ui/dialog";
import { keepOriginalBlocks } from "./blockReview";
import { keepVersion } from "../versions/versions";
import { placementOf, type AiChange } from "./aiUndo";
import { allowed, targets, validateCall, type ToolArgs } from "./toolArguments";
import { readTool, type ToolRequest } from "./readTools";
import { writeTool } from "./writeTools";

export const ATTACHED_PAGES = 10;
const ATTACHED_PAGE_TEXT = 8000;
const ATTACHED_TEXT = 24000;
const TITLE_LENGTH = 200;

export interface AttachedPage {
  id: string;
  title: string;
  kind: Page["kind"];
  text: string;
  truncated: boolean;
}

export interface Draft {
  live: Entry | null;
  copy: Entry;
  base: Uint8Array;
  before: string;
  original: Page | null;
  page: Page;
  applied: boolean;
}

type UndoScope = ConstructorParameters<typeof Y.UndoManager>[0];

function trackedScopes(live: Entry): UndoScope {
  return [
    live.doc.getMap("meta"),
    live.doc.getXmlFragment("blocks"),
    live.doc.getMap("properties"),
    live.doc.getMap("schema"),
    live.doc.getMap("views"),
    live.doc.getMap("automations"),
    live.doc.getArray("row_order"),
  ];
}

export class AgentRun {
  changes = new Map<string, Draft>();
  shared = new Set<string>();
  citations: SearchHit[] = [];
  trace: string[] = [];
  undos: Y.UndoManager[] = [];
  private trees = new Set<Y.UndoManager>();
  private applied = new Map<string, AiChange>();
  origin = {};
  stopped = false;
  calls = 0;
  attached: string[] = [];
  constructor(
    public book: Notebook,
    public current: Entry | null,
    public mode: string,
    public ask: Ask,
    public maxSteps = 25,
  ) {}
  touchesAiPages(args: ToolArgs) {
    return targets(args).some((target) => aiProtected(this.book, target));
  }
  private listed = (id: string) =>
    this.changes.get(id)?.page ?? this.book.pages.get(id);
  excluded(id: unknown) {
    return this.exclusions()(id);
  }
  exclusions() {
    return sharingChecker({ get: this.listed });
  }
  page(id: string) {
    return this.excluded(id) ? undefined : this.listed(id);
  }
  async attach(ids: string[]) {
    const attached: AttachedPage[] = [];
    let remaining = ATTACHED_TEXT;

    for (const id of [...new Set(ids)].slice(0, ATTACHED_PAGES)) {
      const page = this.page(id);

      if (!page || page.archived || page.kind === "chat") continue;
      const entry = await this.entry(id, false);
      const full = entry.kind === "database" ? "" : markdown(entry);
      const text = full.slice(0, Math.min(ATTACHED_PAGE_TEXT, remaining));

      remaining -= text.length;
      this.shared.add(id);
      this.attached.push(id);
      attached.push({
        id,
        title: page.title,
        kind: page.kind,
        text,
        truncated: text.length < full.length,
      });
    }

    return attached;
  }
  async entry(id: string, write: boolean): Promise<Entry> {
    if (this.stopped) throw Error("Cancelled");
    if (this.excluded(id)) throw Error("Unknown page");
    const cached = this.changes.get(id);

    if (cached) {
      if (cached.page.archived) throw Error("Archived page");
      if (!write) return cached.copy;
      const doc = new Y.Doc();

      Y.applyUpdate(doc, Y.encodeStateAsUpdate(cached.copy.doc));
      const draft = {
        ...cached,
        page: { ...cached.page },
        copy: { ...cached.copy, doc },
        applied: false,
      };

      this.changes.set(id, draft);

      return draft.copy;
    }

    const page = this.book.pages.get(id);

    if (!page || page.archived || page.kind === "chat")
      throw Error("Unknown page");
    const live = await this.book.load(id);

    if (!write) return live;
    const base = Y.encodeStateVector(live.doc),
      doc = new Y.Doc();

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(live.doc));
    const copy = { ...live, doc };

    this.changes.set(id, {
      live,
      copy,
      base,
      before: this.describe(live),
      page: { ...page },
      original: { ...page },
      applied: false,
    });

    return copy;
  }
  describe(entry: Entry) {
    if (entry.kind === "database")
      return JSON.stringify({
        schema: fields(entry).toJSON(),
        views: views(entry).toJSON(),
        automations: automations(entry).toJSON(),
        rows: entry.doc.getArray("row_order").length,
      });

    return (
      markdown(entry) +
      "\n" +
      JSON.stringify(entry.doc.getMap("properties").toJSON())
    );
  }
  create(title: string, kind: Page["kind"], parent: string | null) {
    const parentPage = parent ? this.page(parent) : null;

    if (
      !title.trim() ||
      title.length > TITLE_LENGTH ||
      (parent &&
        (!parentPage || parentPage.archived || parentPage.kind === "chat"))
    )
      throw Error("Invalid page");
    const id = crypto.randomUUID(),
      copy: Entry = { id, kind, rev: 0, doc: new Y.Doc() };

    copy.doc.getMap("meta").set("title", title);
    const page = freshPage(id, title, kind, parent);

    this.changes.set(id, {
      live: null,
      copy,
      base: new Uint8Array([0]),
      before: "",
      original: null,
      page,
      applied: false,
    });

    return copy;
  }
  private async checkedCall(name: string, input: unknown) {
    if (this.stopped || ++this.calls > this.maxSteps) throw Error("Step limit");
    const args = validateCall(name, input),
      permission = allowed(name, args, this.mode);

    if (targets(args).some((target) => this.excluded(target)))
      throw Error("Unknown page");
    if (permission === "confirm" && !(await this.confirm(name, args)))
      return null;
    if (this.stopped) throw Error("Cancelled");
    if (permission !== "read" && this.touchesAiPages(args))
      throw Error(
        "AI instructions, templates and memories can only be changed by the user.",
      );

    return args;
  }
  private confirm(name: string, args: ToolArgs) {
    const title = String(this.page(String(args.id))?.title ?? args.id);

    return this.ask(name + " · " + title + "?");
  }
  private request(name: string, args: ToolArgs): ToolRequest {
    const id = String(args.id ?? ""),
      pages = new Map(this.book.pages);

    for (const [key, draft] of this.changes) pages.set(key, draft.page);
    const excluded = this.exclusions();
    const visible = [...pages.values()].filter(
      (page) => !page.archived && page.kind !== "chat" && !excluded(page.id),
    );

    return { name, args, id, pages, visible, excluded };
  }
  async call(name: string, input: unknown) {
    const args = await this.checkedCall(name, input);

    if (!args) return { declined: true };
    const request = this.request(name, args);

    this.trace.push(name + " " + (request.pages.get(request.id)?.title ?? ""));
    const read = readTool(name);

    if (read) return read(this, request);

    return this.write(request);
  }
  private async write({ name, args, pages }: ToolRequest) {
    const previous = this.changes;

    this.changes = new Map(previous);
    let result;

    try {
      result = await writeTool(this, name, args, pages);
    } catch (error) {
      this.changes = previous;
      throw error;
    }

    if (this.mode === "auto") await this.apply();

    return result;
  }
  async apply(ids?: Set<string>, rejectedBlocks?: Map<string, Set<string>>) {
    if (this.stopped) throw Error("Cancelled");
    const changes = [...this.changes.values()].filter(
      (draft) => !draft.applied && (!ids || ids.has(draft.page.id)),
    );

    if (!changes.length) return;
    for (const draft of changes) this.checkReviewable(draft, changes);
    await this.recordOriginals(changes);
    this.trackListings(changes);
    for (const draft of changes)
      this.applyDraft(draft, rejectedBlocks?.get(draft.page.id));
    await this.book.flush();
    for (const draft of changes)
      if (draft.live?.kind === "database") await this.numberNewIds(draft.live);
    await this.book.flush();
    for (const draft of changes) this.recordResult(draft);
  }
  private checkReviewable(draft: Draft, changes: Draft[]) {
    const { page } = draft;

    if (
      page.parent &&
      !this.book.pages.has(page.parent) &&
      !changes.some((other) => other.page.id === page.parent)
    )
      throw Error("Select parent first");
    if (
      draft.live &&
      draft.original &&
      this.describe(draft.live) !== draft.before &&
      !draft.applied
    )
      throw Error("Content changed during review");
    if (
      draft.original &&
      JSON.stringify(this.book.pages.get(page.id)) !==
        JSON.stringify(draft.original)
    )
      throw Error("Page changed during review");
  }
  private undoManager(scope: UndoScope) {
    return new Y.UndoManager(scope, {
      trackedOrigins: new Set([this.origin]),
      captureTimeout: 0,
    });
  }
  private trackListings(changes: Draft[]) {
    const listings = changes.flatMap((draft) =>
      this.book.pages.mapsFor(draft.page),
    );

    for (const listing of new Set(listings)) {
      const tree = this.undoManager(listing);

      this.trees.add(tree);
      this.undos.push(tree);
    }
  }
  private liveEntry(draft: Draft) {
    if (draft.live) return draft.live;
    const live = {
      id: draft.page.id,
      kind: draft.page.kind,
      rev: 0,
      doc: new Y.Doc(),
    };

    this.book.watch(live);
    draft.live = live;

    return live;
  }
  private applyDraft(draft: Draft, rejected: Set<string> | undefined) {
    if (draft.live && rejected?.size)
      keepOriginalBlocks(draft.live, draft.copy, rejected);
    const live = this.liveEntry(draft);
    const meta = draft.copy.doc.getMap("meta");

    this.undos.push(this.undoManager(trackedScopes(live)));
    if (meta.get("title") !== draft.page.title)
      meta.set("title", draft.page.title);
    draft.page.updated = Date.now();
    Y.applyUpdate(
      live.doc,
      Y.encodeStateAsUpdate(draft.copy.doc, draft.base),
      this.origin,
    );
    this.book.pages.set(draft.page.id, { ...draft.page }, this.origin);
    this.book.dirty.add(live.id);
    draft.before = this.describe(live);
    draft.original = { ...draft.page };
    draft.base = Y.encodeStateVector(draft.copy.doc);
    draft.applied = true;
  }
  appliedChanges() {
    return [...this.applied.values()].map((change) => ({ ...change }));
  }
  private async recordOriginals(changes: Draft[]) {
    const fresh = changes.filter((draft) => !this.applied.has(draft.page.id));

    if (fresh.some((draft) => draft.live)) await this.book.flush();

    for (const draft of fresh) {
      const rev = draft.live?.rev
        ? await keepVersion(draft.page.id, null, "ai")
        : null;

      this.applied.set(draft.page.id, {
        id: draft.page.id,
        title: draft.page.title,
        created: !draft.original,
        rev,
        after: 0,
        before: draft.original && placementOf(draft.original),
      });
    }
  }
  private recordResult(draft: Draft) {
    const change = this.applied.get(draft.page.id);

    if (!change || !draft.live) return;
    change.title = draft.page.title;
    change.after = draft.live.rev;
  }
  async numberNewIds(db: Entry) {
    for (const field of fields(db).values())
      if (field.type === "autoId" && counters(db).get(field.id) === undefined)
        await numberRows(this.book, db, field.id);
  }
  async undo() {
    const latestFirst = [...this.undos].reverse();
    const tracksTree = (manager: Y.UndoManager) => this.trees.has(manager);
    const ordered = [
      ...latestFirst.filter(tracksTree),
      ...latestFirst.filter((manager) => !tracksTree(manager)),
    ];

    for (const manager of ordered) {
      while (manager.undoStack.length) manager.undo();
      manager.destroy();
    }

    this.undos = [];
    this.trees.clear();
    this.applied.clear();

    for (const draft of this.changes.values()) {
      if (draft.applied) this.book.dirty.add(draft.page.id);
    }

    await this.book.flush();
  }
}

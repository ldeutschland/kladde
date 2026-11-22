import { splitList } from "../database/compute";
import { fields } from "../database/fields";
import type { Field } from "../database/types";
import type { Page } from "../notebook/notebook";
import type { Word } from "../locale/locale";
import type { AgentRun, Draft } from "./AgentRun";

export interface FactChange {
  key: string;
  word?: Word;
  name?: string;
  before: string;
  after: string;
}

const PAGE_FACTS = ["title", "icon", "cover", "parent", "archived"] as const;
const HIDDEN_TITLE = "…";

type PageFact = (typeof PAGE_FACTS)[number];

const FACT_LABELS: Record<PageFact, Word> = {
  title: "title",
  icon: "icon",
  cover: "cover",
  parent: "moveTo",
  archived: "trash",
};

function titleOf(run: AgentRun, id: string) {
  return run.page(id)?.title ?? HIDDEN_TITLE;
}

function shownFact(run: AgentRun, key: PageFact, page: Page) {
  if (key === "parent") return page.parent ? titleOf(run, page.parent) : "";
  if (key === "archived") return page.archived ? "✓" : "";

  return String(page[key] ?? "");
}

function pageFacts(run: AgentRun, draft: Draft): FactChange[] {
  const original = draft.original;

  if (!original) return [];

  return PAGE_FACTS.flatMap((key) => {
    const before = shownFact(run, key, original),
      after = shownFact(run, key, draft.page);

    return before === after
      ? []
      : [{ key, word: FACT_LABELS[key], before, after }];
  });
}

function shownValue(run: AgentRun, field: Field | undefined, value: string) {
  if (field?.type !== "relation") return value;

  return splitList(value)
    .map((id) => titleOf(run, id))
    .join(", ");
}

function propertyFacts(run: AgentRun, draft: Draft): FactChange[] {
  if (!draft.live || draft.copy.kind !== "row") return [];
  const before = draft.live.doc.getMap<string>("properties").toJSON(),
    after = draft.copy.doc.getMap<string>("properties").toJSON();
  const database = run.changes.get(draft.page.parent ?? "")?.copy;
  const schema = database ? fields(database) : new Map<string, Field>();
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  return [...keys].flatMap((id) => {
    const old = String(before[id] ?? ""),
      next = String(after[id] ?? "");
    const field = schema.get(id);

    return old === next
      ? []
      : [
          {
            key: id,
            name: field?.name ?? id,
            before: shownValue(run, field, old),
            after: shownValue(run, field, next),
          },
        ];
  });
}

export function draftFacts(run: AgentRun, draft: Draft) {
  return [...pageFacts(run, draft), ...propertyFacts(run, draft)];
}

import { useState } from "react";
import { Brain, Check, Undo2 } from "lucide-react";
import { AgentRun } from "../ai/AgentRun";
import { blockReview } from "../ai/blockReview";
import { draftFacts } from "../ai/draftFacts";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Item, MemoryMark } from "./types";

export function AppliedChanges({
  item,
  book,
  t,
  open,
  locked,
  note,
  undo,
}: {
  item: Item;
  book: Notebook;
  t: T;
  open: (id: string) => void;
  locked: boolean;
  note: string;
  undo: () => void;
}) {
  const changes = item.changes ?? [];

  return (
    <section className="aichanges" data-undone={item.undone || undefined}>
      <details className="sharedpages">
        <summary>
          {t(item.undone ? "changesUndone" : "changesApplied")} ·{" "}
          {changes.length}
        </summary>
        {changes.map((change) => {
          const page = book.pages.get(change.id);

          return (
            <button
              key={change.id}
              disabled={!page || !!page.archived}
              onClick={() => open(change.id)}
            >
              {page?.title || change.title || t("untitled")}
              {change.created && <small> · {t("changeCreated")}</small>}
            </button>
          );
        })}
      </details>
      {!item.undone && (
        <button className="undochanges" disabled={locked} onClick={undo}>
          <Undo2 />
          {t("undoShort")}
        </button>
      )}
      {note && <p role="alert">{note}</p>}
    </section>
  );
}

export function Review({
  run,
  t,
  changed,
  applied,
}: {
  run: AgentRun;
  t: T;
  changed: () => void;
  applied: () => Promise<void>;
}) {
  const [chosen, setChosen] = useState(() => new Set(run.changes.keys())),
    [rejected, setRejected] = useState(new Map<string, Set<string>>()),
    [failure, setFailure] = useState("");
  const pending = [...run.changes].filter(([, d]) => !d.applied);

  if (!pending.length) return null;

  async function apply() {
    try {
      await run.apply(chosen, rejected);
      setFailure("");
    } catch (e) {
      setFailure(String(e));
    }

    await applied().catch((e) => setFailure(String(e)));
    changed();
  }

  return (
    <section className="aireview">
      {pending.length > 0 && (
        <>
          <h4>{t("review")}</h4>
          {pending.map(([id, d]) => (
            <details key={id}>
              <summary>
                <input
                  type="checkbox"
                  checked={chosen.has(id)}
                  onChange={() => {
                    const next = new Set(chosen);

                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    setChosen(next);
                  }}
                />
                <span className="grow">{d.page.title || t("untitled")}</span>
              </summary>
              {draftFacts(run, d).map((fact) => (
                <div className="blockchange" key={fact.key}>
                  <strong>{fact.word ? t(fact.word) : fact.name}</strong>
                  <span>
                    <del>{fact.before}</del>
                    <ins>{fact.after}</ins>
                  </span>
                </div>
              ))}
              {blockReview(d.live, d.copy).map((block) => (
                <label className="blockchange" key={block.id}>
                  <input
                    type="checkbox"
                    checked={!rejected.get(id)?.has(block.id)}
                    onChange={(e) => {
                      const next = new Map(rejected),
                        blocks = new Set(next.get(id));

                      if (e.target.checked) blocks.delete(block.id);
                      else blocks.add(block.id);
                      next.set(id, blocks);
                      setRejected(next);
                    }}
                  />
                  <span>
                    <del>{block.before}</del>
                    <ins>{block.after}</ins>
                  </span>
                </label>
              ))}
              {(d.copy.kind === "database" || !d.live) && (
                <>
                  <del>{d.before}</del>
                  <pre>{run.describe(d.copy)}</pre>
                </>
              )}
            </details>
          ))}
          <div className="aiactions">
            <button className="primary" onClick={apply}>
              <Check />
              {t("apply")}
            </button>
            <button
              onClick={() => {
                run.changes.clear();
                changed();
              }}
            >
              {t("discard")}
            </button>
          </div>
        </>
      )}
      {failure && <p role="alert">{failure}</p>}
    </section>
  );
}

export function MemoryNote({
  mark,
  t,
  open,
}: {
  mark: MemoryMark;
  t: T;
  open: (id: string) => void;
}) {
  if (mark.state === "saving")
    return (
      <p className="memorymark" role="status">
        <Brain />
        {t("aiMemorySaving")}
      </p>
    );
  if (mark.state === "failed")
    return (
      <p className="memorymark" role="alert">
        <Brain />
        {t("aiMemoryFailed")}: {mark.error}
      </p>
    );

  return (
    <div className="memorymark" role="status">
      <button
        type="button"
        disabled={!mark.page}
        onClick={() => open(mark.page)}
      >
        <Brain />
        {t("aiMemorySaved")}
        {mark.cost ? <small>${mark.cost.toFixed(4)}</small> : null}
      </button>
      {mark.added.length + mark.removed.length > 0 && (
        <ul>
          {mark.added.map((line, i) => (
            <li key={"a" + i} data-change="added">
              {line}
            </li>
          ))}
          {mark.removed.map((line, i) => (
            <li key={"r" + i} data-change="removed">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

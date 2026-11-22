import { useMemo, useState } from "react";
import { blockEditor, blocks } from "../notebook/content";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T, Word } from "../locale/locale";
import { diffWords } from "./textDiff";
import type { Fact } from "./versionFacts";
import {
  compareBlocks,
  indexBlocks,
  type Block,
  type BlockChange,
} from "./blockChanges";
import { restoreBlock } from "./restoreBlock";

function markdownOf(block: Block | undefined, nested: boolean) {
  if (!block) return "";
  const shown = { ...block, children: nested ? block.children : [] };

  return blockEditor().blocksToMarkdownLossy([shown]).trim();
}

function changeKind(existed: boolean, exists: boolean, moved: boolean): Word {
  if (moved) return "blockMoved";
  if (!existed) return "blockAdded";

  return exists ? "blockChanged" : "blockRemoved";
}

function DiffText({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffWords(before, after), [before, after]);

  return (
    <p className="difftext">
      {parts.map((part, index) => {
        if (part.kind === "added") return <ins key={index}>{part.text}</ins>;
        if (part.kind === "removed") return <del key={index}>{part.text}</del>;

        return <span key={index}>{part.text}</span>;
      })}
    </p>
  );
}

function FactChange({ fact }: { fact: Fact }) {
  return (
    <section className="change">
      <header>
        <span className="changekind">{fact.label}</span>
      </header>
      <DiffText before={fact.before} after={fact.after} />
    </section>
  );
}

function BlockChangeView({
  change: { left, right },
  t,
  restore,
}: {
  change: BlockChange;
  t: T;
  restore: () => void;
}) {
  const before = markdownOf(left?.block, !right);
  const after = markdownOf(right?.block, !left);
  const moved = !!left && !!right && before === after;

  return (
    <section className="change">
      <header>
        <span className="changekind">
          {t(changeKind(!!left, !!right, moved))}
        </span>
        <button onClick={restore}>
          {t(left ? "restoreBlock" : "removeAddedBlock")}
        </button>
      </header>
      <DiffText before={before} after={after} />
    </section>
  );
}

export function VersionChanges({
  entry,
  old,
  facts,
  book,
  t,
  guard,
}: {
  entry: Entry;
  old: Entry;
  facts: Fact[];
  book: Notebook;
  t: T;
  guard: () => Promise<void>;
}) {
  const previous = useMemo(() => indexBlocks(blocks(old)), [old]);
  const [error, setError] = useState("");
  const { changes, samePlace } = compareBlocks(
    previous,
    indexBlocks(blocks(entry)),
  );

  async function restore(id: string) {
    try {
      await guard();
      if (!restoreBlock({ entry, old, previous, samePlace, t }, id)) return;
      await book.flush();
    } catch (problem) {
      setError(String(problem));
    }
  }

  if (!facts.length && !changes.length)
    return <p className="muted versionsame">{t("versionNoChanges")}</p>;

  return (
    <section className="versionchanges">
      <p className="difflegend">
        <del>{t("versionLegendOld")}</del>
        <ins>{t("versionLegendNew")}</ins>
      </p>
      {facts.map((fact) => (
        <FactChange key={fact.key} fact={fact} />
      ))}
      {changes.map((change) => (
        <BlockChangeView
          key={change.id}
          change={change}
          t={t}
          restore={() => void restore(change.id)}
        />
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

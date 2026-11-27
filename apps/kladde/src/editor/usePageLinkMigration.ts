import { useEffect } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { linkedPage } from "../notebook/links";

type Transaction = Parameters<Parameters<BlockNoteEditor["transact"]>[0]>[0];
type DocNode = Transaction["doc"];
type Mark = DocNode["marks"][number];

interface LinkedText {
  from: number;
  to: number;
  page: string;
  marks: readonly Mark[];
}

function pageLinkOf(marks: readonly Mark[]) {
  const link = marks.find((mark) => mark.type.name === "link");
  const page = link ? linkedPage(String(link.attrs.href ?? "")) : null;

  return link && page ? { link, page } : null;
}

function linkedTexts(doc: DocNode) {
  const found: LinkedText[] = [];

  doc.descendants((node, pos) => {
    const linked = node.isText ? pageLinkOf(node.marks) : null;

    if (!linked) return true;
    const last = found.at(-1);
    const to = pos + node.nodeSize;

    if (last?.to === pos && last.page === linked.page) last.to = to;
    else
      found.push({
        from: pos,
        to,
        page: linked.page,
        marks: linked.link.removeFromSet(node.marks),
      });

    return false;
  });

  return found;
}

function convertible(doc: DocNode, text: LinkedText) {
  const type = doc.type.schema.nodes.pageLink;
  const start = doc.resolve(text.from);
  const end = doc.resolve(text.to);

  return (
    !!type &&
    start.parent.canReplaceWith(start.index(), end.index(), type, text.marks)
  );
}

function convertibleLinks(doc: DocNode) {
  return linkedTexts(doc).filter((text) => convertible(doc, text));
}

export function convertPageLinks(editor: BlockNoteEditor) {
  if (!convertibleLinks(editor.prosemirrorState.doc).length) return;
  editor.transact((tr) => {
    const type = tr.doc.type.schema.nodes.pageLink;

    for (const text of convertibleLinks(tr.doc).reverse())
      tr.replaceWith(
        text.from,
        text.to,
        type.create({ page: text.page }, null, text.marks),
      );
    tr.setMeta("addToHistory", false);
  });
}

export function usePageLinkMigration(editor: BlockNoteEditor) {
  useEffect(() => {
    let queued = false;
    let active = true;
    const migrate = () => {
      queued = false;
      if (active) convertPageLinks(editor);
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(migrate);
    };
    const stop = editor.onChange(schedule);

    schedule();

    return () => {
      active = false;
      stop();
    };
  }, [editor]);
}

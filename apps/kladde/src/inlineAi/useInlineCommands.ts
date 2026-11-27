import { useEffect, type KeyboardEvent, type RefObject } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import type { T, Word } from "../locale/locale";
import { pageLinkContextOf, withLinksHidden } from "../editor/pageLinkSpec";
import { sharingChecker } from "../ai/aiPages";
import {
  EDIT_ACTIONS,
  INLINE_SYSTEM,
  INSTRUCTIONS,
  INSTRUCTION_LENGTH,
  PREFILLS,
  WRITE_ACTIONS,
  type InlineStart,
} from "./actions";
import type { InlinePrompt } from "./useInlinePrompt";
import type { InlineRun } from "./useInlineRun";

const DOCUMENT_TEXT = 16000;

interface CommandOptions {
  editor: BlockNoteEditor;
  start: InlineStart;
  t: T;
  prompt: InlinePrompt;
  run: InlineRun;
  box: RefObject<HTMLDivElement | null>;
  field: RefObject<HTMLInputElement | null>;
}

function sourceText(editor: BlockNoteEditor, start: InlineStart) {
  if (start.selection) return start.selection;
  const book = pageLinkContextOf(editor)?.book;
  const hidden = book ? sharingChecker(book.pages) : () => true;
  const text = withLinksHidden(hidden, () =>
    editor.blocksToMarkdownLossy(editor.document),
  );

  return text.slice(-DOCUMENT_TEXT);
}

function shownActions(options: CommandOptions) {
  const { start, t, prompt, run } = options;
  const actions = start.selection ? EDIT_ACTIONS : WRITE_ACTIONS;
  const needle = prompt.query.trim().toLowerCase();

  if (run.result) return [];

  return actions.filter((word) => t(word).toLowerCase().includes(needle));
}

export function useInlineCommands(options: CommandOptions) {
  const { editor, start, prompt, run } = options;
  const shown = shownActions(options);

  useEffect(() => {
    options.box.current?.scrollIntoView({ block: "nearest" });
    options.field.current?.focus();
    if (start.action) choose(start.action);
  }, []);

  function instruct(instruction: string) {
    const text = instruction.trim().slice(0, INSTRUCTION_LENGTH);

    if (!text) return;

    if (run.result && run.asked.length) {
      void run.ask([
        ...run.asked,
        { role: "user", content: JSON.stringify({ instruction: text }) },
      ]);

      return;
    }

    void run.ask([
      { role: "system", content: INLINE_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          instruction: text,
          text: sourceText(editor, start),
        }),
      },
    ]);
  }

  function choose(word: Word) {
    const prefill = PREFILLS[word];

    if (prefill) {
      prompt.type(options.t(prefill));
      options.field.current?.focus();

      return;
    }

    const instruction = INSTRUCTIONS[word];

    if (instruction) instruct(instruction);
  }

  function submit() {
    const chosen = shown[prompt.highlight];

    if (prompt.highlight >= 0 && chosen) choose(chosen);
    else instruct(prompt.query);
  }

  function moveHighlight(event: KeyboardEvent<HTMLInputElement>) {
    const { highlight } = prompt;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      prompt.setHighlight(Math.min(highlight + 1, shown.length - 1));
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      prompt.setHighlight(Math.max(highlight - 1, -1));
    }
  }

  return { shown, choose, submit, moveHighlight };
}

export type InlineCommands = ReturnType<typeof useInlineCommands>;

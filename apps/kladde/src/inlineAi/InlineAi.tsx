import { useEffect, useRef, type RefObject } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { ArrowUp, Sparkles, Square } from "lucide-react";
import { Markdown } from "../ui/Markdown";
import type { Policy } from "../ai/assistant";
import type { T } from "../locale/locale";
import { INSTRUCTION_LENGTH, type InlineStart } from "./actions";
import { insertBelowSelection, replaceSelection } from "./applyResult";
import { useInlinePrompt, type InlinePrompt } from "./useInlinePrompt";
import { useInlineRun, type InlineRun } from "./useInlineRun";
import { useInlineCommands, type InlineCommands } from "./useInlineCommands";
import { ActionMenu, InlineSetup, ResultMenu } from "./InlineMenus";

export interface InlineAiProps {
  editor: BlockNoteEditor;
  policy: Policy;
  space: string;
  start: InlineStart;
  t: T;
  close: () => void;
  setup: () => void;
  keep: () => Promise<void>;
}

function useOutsideClose(
  box: RefObject<HTMLDivElement | null>,
  run: InlineRun,
  close: () => void,
) {
  useEffect(() => {
    function outside(event: MouseEvent) {
      if (box.current?.contains(event.target as Node)) return;
      if (!run.busy && !run.result) close();
    }

    document.addEventListener("mousedown", outside);

    return () => document.removeEventListener("mousedown", outside);
  }, [run.busy, run.result]);
}

function useResultActions(props: InlineAiProps, run: InlineRun) {
  const { editor, start, t } = props;

  async function kept() {
    try {
      await props.keep();

      return true;
    } catch (problem) {
      run.setError(String(problem));

      return false;
    }
  }

  async function replace() {
    const blocks = editor.tryParseMarkdownToBlocks(run.result);

    if (!blocks.length || !(await kept())) return;

    if (editor.getSelectedText() !== start.selection) {
      run.setError(t("selectionChanged"));

      return;
    }

    replaceSelection(editor, start, blocks);
    props.close();
  }

  async function insertBelow() {
    const blocks = editor.tryParseMarkdownToBlocks(run.result);

    if (!blocks.length || !(await kept())) return;

    if (!insertBelowSelection(editor, start, blocks)) {
      run.setError(t("selectionChanged"));

      return;
    }

    props.close();
  }

  return { replace, insertBelow };
}

function InlineForm({
  t,
  run,
  prompt,
  commands,
  field,
}: {
  t: T;
  run: InlineRun;
  prompt: InlinePrompt;
  commands: InlineCommands;
  field: RefObject<HTMLInputElement | null>;
}) {
  return (
    <form
      className="inlineinput"
      onSubmit={(event) => {
        event.preventDefault();
        commands.submit();
      }}
    >
      <Sparkles />
      <input
        ref={field}
        aria-label={t("ai")}
        placeholder={run.result ? t("followUp") : t("inlinePlaceholder")}
        value={prompt.query}
        readOnly={run.busy}
        maxLength={INSTRUCTION_LENGTH}
        onChange={(event) => prompt.type(event.target.value)}
        onKeyDown={commands.moveHighlight}
      />
      {run.busy ? (
        <button
          type="button"
          className="send"
          aria-label={t("stop")}
          onClick={run.stop}
        >
          <Square />
        </button>
      ) : (
        <button
          className="send"
          aria-label={t("send")}
          disabled={!prompt.query.trim() && prompt.highlight < 0}
        >
          <ArrowUp />
        </button>
      )}
    </form>
  );
}

export function InlineAi(props: InlineAiProps) {
  const { start, t, policy, close } = props;
  const box = useRef<HTMLDivElement>(null),
    field = useRef<HTMLInputElement>(null);
  const prompt = useInlinePrompt();
  const run = useInlineRun(props.space, policy, prompt.clear, props.t);
  const commands = useInlineCommands({ ...props, prompt, run, box, field });
  const results = useResultActions(props, run);

  useOutsideClose(box, run, close);

  if (!run.ready)
    return (
      <div className="inlineai" ref={box} style={{ top: start.top }}>
        <InlineSetup t={t} policy={policy} setup={props.setup} close={close} />
      </div>
    );

  return (
    <div
      className="inlineai"
      ref={box}
      style={{ top: start.top }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (run.busy) run.stop();
        else close();
      }}
    >
      {(run.result || run.busy) && (
        <div className="inlineresult">
          {run.result ? (
            <Markdown text={run.result} />
          ) : (
            <p className="thinking">{t("thinking")}</p>
          )}
        </div>
      )}
      <InlineForm
        t={t}
        run={run}
        prompt={prompt}
        commands={commands}
        field={field}
      />
      {run.error && <p role="alert">{run.error}</p>}
      <p className="ainote">
        {t("aiNote")} · {policy.model}
      </p>
      {!run.busy && run.result && (
        <ResultMenu
          t={t}
          canReplace={!!start.selection}
          replace={() => void results.replace()}
          insertBelow={() => void results.insertBelow()}
          retry={run.retry}
          close={close}
        />
      )}
      {!run.busy && commands.shown.length > 0 && (
        <ActionMenu
          t={t}
          title={start.selection ? t("editGroup") : t("writeGroup")}
          shown={commands.shown}
          highlight={prompt.highlight}
          setHighlight={prompt.setHighlight}
          choose={commands.choose}
        />
      )}
    </div>
  );
}

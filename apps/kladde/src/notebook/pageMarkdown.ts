import type { BlockNoteEditor } from "@blocknote/core";
import { blockEditor } from "./content";

type Blocks = ReturnType<BlockNoteEditor["tryParseMarkdownToBlocks"]>;
type Block = Blocks[number];

interface Callout {
  kind: string;
  color: string;
  icon: string;
}

export const CALLOUTS: Callout[] = [
  { kind: "NOTE", color: "blue", icon: "ℹ️" },
  { kind: "TIP", color: "green", icon: "💡" },
  { kind: "IMPORTANT", color: "purple", icon: "📌" },
  { kind: "WARNING", color: "yellow", icon: "⚠️" },
  { kind: "CAUTION", color: "red", icon: "🚨" },
];
const MARKER = /^\[!([a-z]+)\][ \t]*\n?[ \t]*/i;
const EMOJI =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|‍|️)*$/u;
const ICON_LENGTH = 16;

export function emojiIcon(value: unknown) {
  const icon = typeof value === "string" ? value.trim() : "";

  if (!icon || icon.length > ICON_LENGTH || !EMOJI.test(icon))
    throw Error("icon must be a single emoji");

  return icon;
}

function leadingText(block: Block) {
  const first = Array.isArray(block.content) ? block.content[0] : undefined;

  return first?.type === "text" ? first : undefined;
}

function withLead(block: Block, text: string): Block {
  const first = leadingText(block);

  if (!first || !Array.isArray(block.content)) return block;
  const content = [{ ...first, text }, ...block.content.slice(1)];

  return { ...block, content } as Block;
}

function asCallout(block: Block): Block {
  const first = leadingText(block);
  const marker = first ? MARKER.exec(first.text) : null;

  if (block.type !== "quote" || !first || !marker) return block;
  const callout = CALLOUTS.find((c) => c.kind === marker[1].toUpperCase());

  if (!callout) return block;
  const text = callout.icon + " " + first.text.slice(marker[0].length);
  const props = { ...block.props, backgroundColor: callout.color };

  return withLead({ ...block, props }, text);
}

export function styleCallouts(blocks: Blocks): Blocks {
  return blocks.map((block) => ({
    ...asCallout(block),
    children: styleCallouts(block.children),
  }));
}

export function pageBlocks(text: string) {
  return styleCallouts(blockEditor().tryParseMarkdownToBlocks(text));
}

function calloutOf(block: Block) {
  if (block.type !== "quote") return undefined;
  const text = leadingText(block)?.text ?? "";

  return CALLOUTS.find(
    (c) => c.color === block.props.backgroundColor && text.startsWith(c.icon),
  );
}

export function markCallouts(block: Block): Block {
  const callout = calloutOf(block);
  const text = leadingText(block)?.text ?? "";
  const marked = callout
    ? withLead(
        block,
        "[!" + callout.kind + "] " + text.slice(callout.icon.length).trim(),
      )
    : block;

  return { ...marked, children: block.children.map(markCallouts) };
}

function summaryLine(block: Block) {
  const row = blockEditor().blocksToMarkdownLossy([
    { type: "paragraph", content: block.content } as Block,
  ]);

  return row.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

export function blockMarkdown(block: Block): string {
  const editor = blockEditor();

  if (block.type !== "toggleListItem")
    return editor.blocksToMarkdownLossy([markCallouts(block)]);
  const body = editor.blocksToMarkdownLossy(block.children.map(markCallouts));
  const summary = "<details><summary>" + summaryLine(block) + "</summary>";

  return [summary, body.trim(), "</details>"].join("\n\n") + "\n";
}

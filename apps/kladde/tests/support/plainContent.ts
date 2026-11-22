import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import type * as Content from "../../src/notebook/content";
import type * as PageMarkdown from "../../src/notebook/pageMarkdown";

type ContentModule = typeof Content;
type PageMarkdownModule = typeof PageMarkdown;
type Parsed = Parameters<
  NonNullable<Parameters<ContentModule["writeMarkdown"]>[2]>
>[0];

interface LooseBlock {
  content?: unknown;
}

function inlineText(content: unknown) {
  if (!Array.isArray(content)) return "";

  return content
    .map((part: { text?: unknown }) =>
      typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

export function plainText(list: LooseBlock[]) {
  return list.map((block) => inlineText(block.content)).join("\n\n");
}

export function paragraphs(text: string): Parsed {
  return text
    .split("\n\n")
    .filter((part) => part.trim())
    .map((part) => ({
      id: crypto.randomUUID(),
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: part, styles: {} }],
      children: [],
    })) as unknown as Parsed;
}

export function plainContent(original: unknown): ContentModule {
  const actual = original as ContentModule;
  const real = actual.blockEditor();
  const editor = new Proxy(real, {
    get(target, key) {
      if (key === "blocksToMarkdownLossy") return plainText;
      if (key === "tryParseMarkdownToBlocks") return paragraphs;
      const value = Reflect.get(target, key, target);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    ...actual,
    blockEditor: () => editor,
    markdown: (entry) => plainText(actual.blocks(entry)),
    writeMarkdown: (entry, text, adjust = (blocks) => blocks) => {
      const fragment = entry.doc.getXmlFragment("blocks");

      entry.doc.transact(() => {
        fragment.delete(0, fragment.length);
        blocksToYXmlFragment(real, adjust(paragraphs(text)), fragment);
        entry.doc.getMap("meta").set("text", text);
      });
    },
  };
}

export function plainPageMarkdown(original: unknown): PageMarkdownModule {
  return {
    ...(original as PageMarkdownModule),
    pageBlocks: paragraphs as PageMarkdownModule["pageBlocks"],
  };
}

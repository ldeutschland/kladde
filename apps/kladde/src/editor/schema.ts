import {
  BlockNoteSchema,
  createCodeBlockSpec,
  type BlockNoteEditor,
} from "@blocknote/core";
import { codeBlockOptions } from "@blocknote/code-block";
import "@blocknote/mantine/style.css";
import { fileBlock } from "./FileBlock";
import { pageLinkSpec } from "./pageLinkSpec";

export const schema = BlockNoteSchema.create().extend({
  blockSpecs: {
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    file: fileBlock(),
  },
  inlineContentSpecs: { pageLink: pageLinkSpec },
});

export type NotebookEditor = BlockNoteEditor<
  typeof schema.blockSchema,
  typeof schema.inlineContentSchema,
  typeof schema.styleSchema
>;

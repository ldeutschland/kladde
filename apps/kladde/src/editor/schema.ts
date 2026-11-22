import { BlockNoteSchema, createCodeBlockSpec } from "@blocknote/core";
import { codeBlockOptions } from "@blocknote/code-block";
import "@blocknote/mantine/style.css";
import { fileBlock } from "./FileBlock";

export const schema = BlockNoteSchema.create().extend({
  blockSpecs: {
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    file: fileBlock(),
  },
});

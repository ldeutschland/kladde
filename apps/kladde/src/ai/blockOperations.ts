import { blocks } from "../notebook/content";
import { pageBlocks } from "../notebook/pageMarkdown";
import { MARKDOWN_LENGTH } from "./toolCatalog";
import { objectArg, textArg, type ToolArgs } from "./toolArguments";

type Blocks = ReturnType<typeof blocks>;

function moveBlock(all: Blocks, index: number, operation: ToolArgs) {
  const after = all.find((block) => block.id === operation.after);

  if (!after || after.id === operation.block_id) throw Error("Invalid target");
  const [moved] = all.splice(index, 1);

  all.splice(all.indexOf(after) + 1, 0, moved);
}

function writeBlocks(all: Blocks, index: number, operation: ToolArgs) {
  const text = textArg(operation.markdown, MARKDOWN_LENGTH);

  if (!text.trim()) throw Error("Use the delete action to remove a block");
  const replacement = pageBlocks(text);
  const replace = operation.action === "replace";

  if (replace && replacement.length) replacement[0].id = all[index].id;
  all.splice(replace ? index : index + 1, replace ? 1 : 0, ...replacement);
}

function applyOperation(all: Blocks, value: unknown) {
  const operation = objectArg(value),
    index = all.findIndex((block) => block.id === operation.block_id);

  if (index < 0) throw Error("Unknown block");
  if (operation.action === "delete") all.splice(index, 1);
  else if (operation.action === "move") moveBlock(all, index, operation);
  else if (
    operation.action === "replace" ||
    operation.action === "insert_after"
  )
    writeBlocks(all, index, operation);
  else throw Error("Invalid operation");
}

export function applyBlockOperations(all: Blocks, operations: unknown[]) {
  for (const operation of operations) applyOperation(all, operation);
}

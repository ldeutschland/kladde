import type { ReactNode } from "react";

type LinkAction = (href: string) => (() => void) | undefined;

interface Source {
  lines: string[];
  resolve?: LinkAction;
}

interface Block {
  node: ReactNode;
  next: number;
}

type BlockReader = (source: Source, start: number, key: number) => Block | null;

const INLINE =
  /(\[[^\]]+\]\(<?[^)\s>]+>?\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
const LINK = /^\[([^\]]+)\]\(<?([^)\s>]+)>?\)$/;
const FENCE = "```";
const HEADING = /^(#{1,6})\s+(.*)$/;
const HEADING_START = /^#{1,6}\s/;
const RULE = /^\s*(-{3,}|\*{3,})\s*$/;
const BULLET = /^\s*[-*+]\s/;
const BULLET_MARK = /^\s*[-*+]\s+/;
const TASK = /^\[( |x|X)\]\s*(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s/;
const NUMBER_MARK = /^\s*\d+[.)]\s+/;
const QUOTE_MARK = /^>\s?/;
const TABLE_DIVIDER = /^\|?[\s:|-]+\|?$/;
const HEADING_TAGS = ["h3", "h4"] as const;
const NESTING_LIMIT = 3;

function link(label: string, href: string, key: number, resolve?: LinkAction) {
  const action = resolve?.(href);

  if (action)
    return (
      <button key={key} className="mdlink" onClick={action}>
        {label}
      </button>
    );

  return (
    <span key={key} className="mdurl" title={href}>
      {label}
    </span>
  );
}

function inline(text: string, resolve?: LinkAction, depth = 0): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    const nested = (inner: string) =>
      depth < NESTING_LIMIT ? inline(inner, resolve, depth + 1) : inner;
    const linked = LINK.exec(part);

    if (linked) return link(linked[1], linked[2], index, resolve);
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={index}>{nested(part.slice(2, -2))}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return <code key={index}>{part.slice(1, -1)}</code>;
    const italic =
      (part.startsWith("*") && part.endsWith("*")) ||
      (part.startsWith("_") && part.endsWith("_"));

    if (italic && part.length > 2)
      return <em key={index}>{nested(part.slice(1, -1))}</em>;

    return part;
  });
}

function isSpecial(line: string) {
  return (
    line.startsWith(FENCE) ||
    line.startsWith(">") ||
    line.startsWith("|") ||
    HEADING_START.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    RULE.test(line)
  );
}

function cells(line: string) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function endOf(
  lines: string[],
  start: number,
  matches: (line: string) => boolean,
) {
  let end = start;

  while (end < lines.length && matches(lines[end])) end++;

  return end;
}

const readCode: BlockReader = ({ lines }, start, key) => {
  if (!lines[start].startsWith(FENCE)) return null;
  const end = endOf(lines, start + 1, (line) => !line.startsWith(FENCE));

  return {
    node: (
      <pre key={key}>
        <code>{lines.slice(start + 1, end).join("\n")}</code>
      </pre>
    ),
    next: end + 1,
  };
};

const readHeading: BlockReader = ({ lines, resolve }, start, key) => {
  const heading = HEADING.exec(lines[start]);

  if (!heading) return null;
  const Tag = HEADING_TAGS[heading[1].length - 1] ?? "h5";

  return {
    node: <Tag key={key}>{inline(heading[2], resolve)}</Tag>,
    next: start + 1,
  };
};

const readRule: BlockReader = ({ lines }, start, key) => {
  if (!RULE.test(lines[start])) return null;

  return { node: <hr key={key} />, next: start + 1 };
};

function bulletItem(line: string, index: number, resolve?: LinkAction) {
  const item = line.replace(BULLET_MARK, "");
  const task = TASK.exec(item);

  return (
    <li key={index} className={task ? "task" : undefined}>
      {task && <input type="checkbox" checked={task[1] !== " "} readOnly />}
      {inline(task ? task[2] : item, resolve)}
    </li>
  );
}

const readBullets: BlockReader = ({ lines, resolve }, start, key) => {
  if (!BULLET.test(lines[start])) return null;
  const end = endOf(lines, start, (line) => BULLET.test(line));
  const items = lines
    .slice(start, end)
    .map((line, index) => bulletItem(line, index, resolve));

  return { node: <ul key={key}>{items}</ul>, next: end };
};

const readNumbered: BlockReader = ({ lines, resolve }, start, key) => {
  if (!NUMBERED.test(lines[start])) return null;
  const end = endOf(lines, start, (line) => NUMBERED.test(line));
  const items = lines
    .slice(start, end)
    .map((line, index) => (
      <li key={index}>{inline(line.replace(NUMBER_MARK, ""), resolve)}</li>
    ));

  return { node: <ol key={key}>{items}</ol>, next: end };
};

const readQuote: BlockReader = ({ lines, resolve }, start, key) => {
  if (!lines[start].startsWith(">")) return null;
  const end = endOf(lines, start, (line) => line.startsWith(">"));
  const quote = lines
    .slice(start, end)
    .map((line) => line.replace(QUOTE_MARK, ""))
    .join(" ");

  return {
    node: <blockquote key={key}>{inline(quote, resolve)}</blockquote>,
    next: end,
  };
};

function Table({ rows, resolve }: { rows: string[][]; resolve?: LinkAction }) {
  const [head, ...body] = rows;

  return (
    <div className="mdtable">
      <table>
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={index}>{inline(cell, resolve)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column}>{inline(cell, resolve)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const readTable: BlockReader = ({ lines, resolve }, start, key) => {
  if (!lines[start].startsWith("|")) return null;
  const end = endOf(lines, start, (line) => line.startsWith("|"));
  const rows = lines
    .slice(start, end)
    .filter((line) => !TABLE_DIVIDER.test(line.trim()))
    .map(cells);

  if (!rows.length) return { node: null, next: end };

  return { node: <Table key={key} rows={rows} resolve={resolve} />, next: end };
};

function readParagraph({ lines, resolve }: Source, start: number, key: number) {
  const end = endOf(
    lines,
    start + 1,
    (line) => !!line.trim() && !isSpecial(line),
  );
  const parts = lines.slice(start, end).map((part, index) => (
    <span key={index}>
      {index > 0 && <br />}
      {inline(part, resolve)}
    </span>
  ));

  return { node: <p key={key}>{parts}</p>, next: end };
}

const BLOCK_READERS = [
  readCode,
  readHeading,
  readRule,
  readBullets,
  readNumbered,
  readQuote,
  readTable,
];

function readBlock(source: Source, start: number, key: number): Block {
  for (const read of BLOCK_READERS) {
    const block = read(source, start, key);

    if (block) return block;
  }

  return readParagraph(source, start, key);
}

export function Markdown({
  text,
  resolve,
}: {
  text: string;
  resolve?: LinkAction;
}) {
  const source = { lines: text.replace(/\r/g, "").split("\n"), resolve };
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < source.lines.length) {
    if (!source.lines[index].trim()) {
      index++;
      continue;
    }

    const block = readBlock(source, index, blocks.length);

    if (block.node) blocks.push(block.node);
    index = block.next;
  }

  return <div className="markdown">{blocks}</div>;
}

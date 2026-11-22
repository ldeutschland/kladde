import { FormulaError } from "./errors";
import { tokenize, type Token } from "./tokenize";
import { knownFunctions } from "./functions";
import type { Value } from "./values";

export const FORMULA_LENGTH = 2000;
const MAX_DEPTH = 60;
const CACHE_LIMIT = 300;

export type Node =
  | { kind: "literal"; value: Value }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "variable"; name: string }
  | { kind: "unary"; op: string; arg: Node }
  | { kind: "binary"; op: string; left: Node; right: Node };

const BINARY_LEVELS = [
  ["||"],
  ["&&"],
  ["==", "!=", "=", "<>"],
  ["<", "<=", ">", ">="],
  ["+", "-"],
  ["*", "/", "%"],
];

class Parser {
  private index = 0;
  constructor(private tokens: Token[]) {}

  parse() {
    if (!this.tokens.length) return { kind: "literal", value: null } as Node;
    const node = this.binary(0, 0);

    if (this.index < this.tokens.length)
      throw new FormulaError("syntax", this.describe(this.tokens[this.index]));

    return node;
  }

  private describe(token: Token | undefined) {
    return token ? String(token.value) : "";
  }

  private peekOp(values: string[]) {
    const token = this.tokens[this.index];

    return token?.kind === "op" && values.includes(token.value)
      ? token.value
      : null;
  }

  private expect(value: string) {
    if (this.peekOp([value]) === null) throw new FormulaError("syntax", value);
    this.index++;
  }

  private binary(level: number, depth: number): Node {
    if (depth > MAX_DEPTH) throw new FormulaError("tooComplex");
    if (level >= BINARY_LEVELS.length) return this.power(depth);
    let left = this.binary(level + 1, depth);

    for (
      let op = this.peekOp(BINARY_LEVELS[level]);
      op;
      op = this.peekOp(BINARY_LEVELS[level])
    ) {
      this.index++;
      const right = this.binary(level + 1, depth);

      left = { kind: "binary", op, left, right };
    }

    return left;
  }

  private power(depth: number): Node {
    const base = this.unary(depth);

    if (!this.peekOp(["^"])) return base;
    this.index++;

    return {
      kind: "binary",
      op: "^",
      left: base,
      right: this.power(depth + 1),
    };
  }

  private unary(depth: number): Node {
    if (depth > MAX_DEPTH) throw new FormulaError("tooComplex");
    const op = this.peekOp(["-", "!", "+"]);

    if (!op) return this.postfix(depth);
    this.index++;

    return { kind: "unary", op, arg: this.unary(depth + 1) };
  }

  private postfix(depth: number): Node {
    let node = this.primary(depth);

    while (this.peekOp(["."])) {
      this.index++;
      const token = this.tokens[this.index++];

      if (token?.kind !== "name") throw new FormulaError("syntax", ".");
      this.expect("(");
      node = this.call(token.value, [node, ...this.items(")", depth)]);
    }

    return node;
  }

  private items(close: string, depth: number) {
    const args: Node[] = [];

    while (!this.peekOp([close])) {
      args.push(this.binary(0, depth + 1));
      if (!this.peekOp([","])) break;
      this.index++;
    }

    this.expect(close);

    return args;
  }

  private call(name: string, args: Node[]): Node {
    const lower = name.toLowerCase();

    if (!knownFunctions.has(lower))
      throw new FormulaError("unknownFunction", name);

    return { kind: "call", name: lower, args };
  }

  private primary(depth: number): Node {
    const token = this.tokens[this.index++];

    if (!token) throw new FormulaError("syntax");
    if (token.kind === "number" || token.kind === "text")
      return { kind: "literal", value: token.value };

    if (token.kind === "op" && token.value === "(") {
      const inner = this.binary(0, depth + 1);

      this.expect(")");

      return inner;
    }

    if (token.kind === "op" && token.value === "[")
      return this.call("list", this.items("]", depth));
    if (token.kind !== "name") throw new FormulaError("syntax", token.value);
    const lower = token.value.toLowerCase();

    if (lower === "true" || lower === "false")
      return { kind: "literal", value: lower === "true" };
    if (!this.peekOp(["("])) return { kind: "variable", name: lower };
    this.index++;

    return this.call(token.value, this.items(")", depth));
  }
}

const compiled = new Map<string, Node>();

export function compile(source: string) {
  if (typeof source !== "string" || source.length > FORMULA_LENGTH)
    throw new FormulaError("tooComplex");
  const cached = compiled.get(source);

  if (cached) return cached;
  const node = new Parser(tokenize(source)).parse();

  if (compiled.size >= CACHE_LIMIT) compiled.clear();
  compiled.set(source, node);

  return node;
}

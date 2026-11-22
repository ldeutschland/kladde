import { FormulaError } from "./errors";
import { compile, type Node } from "./parser";
import { ITERATORS, eager, lazy } from "./functions";
import { limitList, listItems } from "./lists";
import {
  cleanNumber,
  compare,
  limitText,
  rowOf,
  same,
  toNumber,
  toText,
  truthy,
  type FormulaScope,
  type Value,
} from "./values";

const MAX_STEPS = 20000;

type Variables = ReadonlyMap<string, Value>;

interface Evaluation {
  scope: FormulaScope;
  steps: number;
}

const NO_VARIABLES: Variables = new Map();

function unary(op: string, value: Value): Value {
  if (op === "!") return !truthy(value);

  return op === "-" ? -toNumber(value) : toNumber(value);
}

function operate(op: string, left: Value, right: Value): Value {
  switch (op) {
    case "+":
      if (typeof left === "string" || typeof right === "string")
        return limitText(toText(left) + toText(right));

      return cleanNumber(toNumber(left) + toNumber(right));
    case "-":
      return cleanNumber(toNumber(left) - toNumber(right));
    case "*":
      return cleanNumber(toNumber(left) * toNumber(right));
    case "/":
      return cleanNumber(toNumber(left) / toNumber(right));
    case "%":
      return cleanNumber(toNumber(left) % toNumber(right));
    case "^":
      return cleanNumber(toNumber(left) ** toNumber(right));
    case "==":
    case "=":
      return same(left, right);
    case "!=":
    case "<>":
      return !same(left, right);
    case "<":
      return compare(left, right) < 0;
    case "<=":
      return compare(left, right) <= 0;
    case ">":
      return compare(left, right) > 0;
    default:
      return compare(left, right) >= 0;
  }
}

function variable(name: string, variables: Variables) {
  if (!variables.has(name)) throw new FormulaError("unknownName", name);

  return variables.get(name) ?? null;
}

function run(state: Evaluation, node: Node, variables: Variables): Value {
  if (++state.steps > MAX_STEPS) throw new FormulaError("tooComplex");
  if (node.kind === "literal") return node.value;
  if (node.kind === "variable") return variable(node.name, variables);
  if (node.kind === "unary")
    return unary(node.op, run(state, node.arg, variables));
  if (node.kind === "binary") return binary(state, node, variables);

  return call(state, node.name, node.args, variables);
}

function binary(
  state: Evaluation,
  node: Extract<Node, { kind: "binary" }>,
  variables: Variables,
) {
  const { op, left, right } = node;
  const value = (side: Node) => run(state, side, variables);

  if (op === "&&") return truthy(value(left)) && truthy(value(right));
  if (op === "||") return truthy(value(left)) || truthy(value(right));

  return operate(op, value(left), value(right));
}

function bind(
  state: Evaluation,
  name: string,
  args: Node[],
  variables: Variables,
) {
  if (args.length < 3 || args.length % 2 === 0)
    throw new FormulaError("arguments", name);
  const next = new Map(variables);

  for (let index = 0; index + 1 < args.length; index += 2) {
    const target = args[index];

    if (target.kind !== "variable") throw new FormulaError("arguments", name);
    next.set(target.name, run(state, args[index + 1], next));
  }

  return run(state, args[args.length - 1], next);
}

function recover(state: Evaluation, args: Node[], variables: Variables) {
  if (args.length !== 2) throw new FormulaError("arguments", "ifError");

  try {
    return run(state, args[0], variables);
  } catch (error) {
    if (!(error instanceof FormulaError) || state.steps > MAX_STEPS)
      throw error;

    return run(state, args[1], variables);
  }
}

function choose(
  state: Evaluation,
  name: string,
  args: Node[],
  variables: Variables,
) {
  const value = (arg: Node) => run(state, arg, variables);
  const truth = (arg: Node) => truthy(value(arg));

  if (name === "and") return args.every(truth);
  if (name === "or") return args.some(truth);

  if (name === "if") {
    if (args.length < 2 || args.length > 3)
      throw new FormulaError("arguments", name);
    if (truth(args[0])) return value(args[1]);

    return args[2] ? value(args[2]) : null;
  }

  if (args.length < 2) throw new FormulaError("arguments", name);
  for (let index = 0; index + 1 < args.length; index += 2)
    if (truth(args[index])) return value(args[index + 1]);

  return args.length % 2 ? value(args[args.length - 1]) : null;
}

function iterate(
  state: Evaluation,
  name: string,
  args: Node[],
  variables: Variables,
) {
  if (args.length !== 2) throw new FormulaError("arguments", name);
  const items = listItems(run(state, args[0], variables));
  const each = (item: Value, index: number) => {
    const next = new Map(variables);

    next.set("current", item);
    next.set("index", index);

    return run(state, args[1], next);
  };
  const test = (item: Value, index: number) => truthy(each(item, index));

  if (name === "map") return limitList(items.map(each));
  if (name === "filter") return items.filter(test);
  if (name === "find") return items.find(test) ?? null;
  if (name === "findindex") return items.findIndex(test);
  if (name === "some") return items.some(test);

  return items.every(test);
}

function property(state: Evaluation, args: Node[], variables: Variables) {
  const { scope } = state;
  const value = (arg: Node) => run(state, arg, variables);

  if (args.length === 1) return scope.prop(toText(value(args[0])));
  if (args.length !== 2) throw new FormulaError("arguments", "prop");
  const row = rowOf(value(args[0]));
  const name = toText(value(args[1]));

  if (!scope.rowProp) throw new FormulaError("unknownProperty", name);

  return scope.rowProp(row, name);
}

function call(
  state: Evaluation,
  name: string,
  args: Node[],
  variables: Variables,
): Value {
  if (name === "prop") return property(state, args, variables);
  if (ITERATORS.includes(name)) return iterate(state, name, args, variables);
  if (name === "let" && args.length !== 3)
    throw new FormulaError("arguments", name);
  if (name === "let" || name === "lets")
    return bind(state, name, args, variables);
  if (name === "iferror") return recover(state, args, variables);
  if (lazy.has(name)) return choose(state, name, args, variables);
  const [min, max, fn] = eager[name];

  if (args.length < min || args.length > max)
    throw new FormulaError("arguments", name);

  return fn(
    args.map((arg) => run(state, arg, variables)),
    state.scope,
  );
}

export function evaluate(node: Node, scope: FormulaScope) {
  return run({ scope, steps: 0 }, node, NO_VARIABLES);
}

export function runFormula(source: string, scope: FormulaScope) {
  return evaluate(compile(source), scope);
}

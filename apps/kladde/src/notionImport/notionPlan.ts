import { markdownLinks } from "./notionMarkdown";

const EXPORT_NAME = /^(.*?) ?([0-9a-f]{32})(_all)?\.(md|csv)$/i;
const NOTION_URL_ID =
  /notion\.so\/(?:[^\s/?#)]*[-/])?([0-9a-f]{32})(?=[?#)\s]|$)/i;
const HEADING = /^#\s+(.+?)\s*$/;

export type NodeKind = "page" | "database" | "row";

export interface Source {
  path: string;
  text: string;
}

export interface PlanNode {
  notionId: string;
  path: string;
  kind: NodeKind;
  title: string;
  parent: string | null;
  text: string;
  viewTable: string;
}

export interface Plan {
  nodes: Map<string, PlanNode>;
  byPath: Map<string, string>;
}

interface ExportName {
  base: string;
  notionId: string;
  complete: boolean;
  extension: string;
}

export function exportName(path: string): ExportName | null {
  const match = EXPORT_NAME.exec(fileName(path));

  if (!match) return null;

  return {
    base: match[1],
    notionId: match[2].toLowerCase(),
    complete: Boolean(match[3]),
    extension: match[4].toLowerCase(),
  };
}

export function looksLikeNotionExport(paths: string[]) {
  return paths.some((path) => exportName(path)?.extension === "md");
}

export function fileName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function directory(path: string) {
  const slash = path.lastIndexOf("/");

  return slash < 0 ? "" : path.slice(0, slash);
}

export function normalizePath(path: string) {
  const parts: string[] = [];

  for (const raw of path.normalize("NFC").split("/")) {
    const part = raw.trimEnd();

    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }

  return parts.join("/");
}

function decoded(href: string) {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

export function resolveHref(fromPath: string, href: string) {
  const clean = href.split("#")[0].split("?")[0];

  return normalizePath(directory(fromPath) + "/" + decoded(clean));
}

export function notionUrlId(href: string) {
  return NOTION_URL_ID.exec(href)?.[1].toLowerCase() ?? null;
}

export function isWebHref(href: string) {
  return /^(?:https?:|mailto:|data:)/i.test(href);
}

export function stripCommonRoot(paths: string[]) {
  const first = paths[0]?.split("/")[0] ?? "";
  const shared =
    first &&
    paths.every(
      (path) => path.startsWith(first + "/") && path.length > first.length + 1,
    );

  return shared ? paths.map((path) => path.slice(first.length + 1)) : paths;
}

function headingTitle(text: string) {
  const firstLine = text.replace(/^\uFEFF/, "").split("\n", 1)[0];

  return HEADING.exec(firstLine)?.[1] ?? "";
}

function addTable(
  nodes: Map<string, PlanNode>,
  source: Source,
  name: ExportName,
) {
  const node = nodes.get(name.notionId) ?? {
    notionId: name.notionId,
    path: source.path,
    kind: "database",
    title: name.base,
    parent: null,
    text: "",
    viewTable: "",
  };

  if (name.complete) node.text = source.text;
  else {
    node.path = source.path;
    node.viewTable = source.text;
    node.text ||= source.text;
  }

  nodes.set(name.notionId, node);
}

function addPage(
  nodes: Map<string, PlanNode>,
  source: Source,
  name: ExportName,
) {
  if (nodes.has(name.notionId)) return;
  nodes.set(name.notionId, {
    notionId: name.notionId,
    path: source.path,
    kind: "page",
    title: headingTitle(source.text) || name.base,
    parent: null,
    text: source.text,
    viewTable: "",
  });
}

function collectNodes(sources: Source[]) {
  const nodes = new Map<string, PlanNode>();

  for (const source of sources) {
    const name = exportName(source.path);

    if (name?.extension === "csv") addTable(nodes, source, name);
  }

  for (const source of sources) {
    const name = exportName(source.path);

    if (name?.extension === "md") addPage(nodes, source, name);
  }

  return nodes;
}

export function linkedNotionId(
  fromPath: string,
  href: string,
  byPath: Map<string, string>,
) {
  if (isWebHref(href)) return notionUrlId(href);
  const path = resolveHref(fromPath, href);

  return byPath.get(path) ?? exportName(path)?.notionId ?? null;
}

function linkTargets(node: PlanNode, byPath: Map<string, string>) {
  if (node.kind === "database") return [];
  const targets: string[] = [];

  for (const link of markdownLinks(node.text)) {
    const id = linkedNotionId(node.path, link.href, byPath);

    if (id && !targets.includes(id)) targets.push(id);
  }

  return targets;
}

function folderOwners(nodes: Map<string, PlanNode>) {
  const owners = new Map<string, PlanNode[]>();

  for (const node of nodes.values()) {
    const name = exportName(node.path);

    if (!name) continue;
    const id = name.notionId;
    const base = directory(node.path) + "/" + name.base.trim();

    for (const folder of [base, `${base} ${id.slice(0, 4)}-${id.slice(-4)}`]) {
      const key = normalizePath(folder);

      owners.set(key, [...(owners.get(key) ?? []), node]);
    }
  }

  return owners;
}

function chooseOwner(
  candidates: PlanNode[],
  child: PlanNode,
  links: Map<string, string[]>,
) {
  if (candidates.length === 1) return candidates[0];
  const linking = candidates.find((c) =>
    links.get(c.notionId)?.includes(child.notionId),
  );

  if (linking) return linking;
  const database = candidates.find((c) => c.kind === "database");

  if (database && child.path.toLowerCase().endsWith(".md")) return database;

  return candidates.find((c) => c.kind === "page") ?? candidates[0];
}

function assignParents(
  nodes: Map<string, PlanNode>,
  links: Map<string, string[]>,
) {
  const owners = folderOwners(nodes);

  for (const node of nodes.values()) {
    const folder = directory(node.path);
    const candidates = (owners.get(normalizePath(folder)) ?? []).filter(
      (c) => c.notionId !== node.notionId,
    );

    if (!candidates.length) continue;
    const owner = chooseOwner(candidates, node, links);

    node.parent = owner.notionId;
    if (owner.kind === "database" && node.kind === "page") node.kind = "row";
  }
}

function breakCycles(nodes: Map<string, PlanNode>) {
  for (const node of nodes.values()) {
    const seen = new Set([node.notionId]);
    let parent = node.parent;

    while (parent) {
      if (seen.has(parent)) {
        node.parent = null;
        if (node.kind === "row") node.kind = "page";
        break;
      }

      seen.add(parent);
      parent = nodes.get(parent)?.parent ?? null;
    }
  }
}

function databaseTitles(nodes: Map<string, PlanNode>) {
  for (const node of nodes.values()) {
    if (node.kind === "database") continue;

    for (const link of markdownLinks(node.text)) {
      if (isWebHref(link.href) || !link.label.trim()) continue;
      const target = exportName(resolveHref(node.path, link.href));

      if (target?.extension !== "csv") continue;
      const database = nodes.get(target.notionId);

      if (database?.kind === "database")
        database.title =
          link.label.replace(/^[*_`]+|[*_`]+$/g, "").trim() || database.title;
    }
  }
}

export function buildPlan(sources: Source[]): Plan {
  const nodes = collectNodes(sources);
  const byPath = new Map<string, string>();

  for (const source of sources) {
    const name = exportName(source.path);

    if (name && nodes.has(name.notionId))
      byPath.set(source.path, name.notionId);
  }

  const links = new Map<string, string[]>();

  for (const node of nodes.values())
    links.set(node.notionId, linkTargets(node, byPath));
  assignParents(nodes, links);
  breakCycles(nodes);
  databaseTitles(nodes);

  return { nodes, byPath };
}

export function childrenInOrder(plan: Plan, parent: string | null) {
  const children = [...plan.nodes.values()].filter((n) => n.parent === parent);
  const owner = parent ? plan.nodes.get(parent) : undefined;
  const order = owner ? linkTargets(owner, plan.byPath) : [];
  const rank = (node: PlanNode) => {
    const index = order.indexOf(node.notionId);

    return index < 0 ? order.length : index;
  };

  return children.sort(
    (a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title),
  );
}

export function creationOrder(plan: Plan) {
  const ordered: PlanNode[] = [];
  const pending: (string | null)[] = [null];

  for (let i = 0; i < pending.length; i++) {
    for (const child of childrenInOrder(plan, pending[i])) {
      ordered.push(child);
      pending.push(child.notionId);
    }
  }

  return ordered;
}

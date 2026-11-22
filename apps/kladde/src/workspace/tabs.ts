export interface Tab {
  key: string;
  trail: (string | null)[];
  cursor: number;
}
export interface TabSet {
  list: Tab[];
  active: string;
}

const TRAIL_LENGTH = 100;
const TAB_LIMIT = 30;

function newTab(page: string | null): Tab {
  return { key: crypto.randomUUID(), trail: [page], cursor: 0 };
}

export function startTabs(): TabSet {
  const tab = newTab(null);

  return { list: [tab], active: tab.key };
}

export function activeTab(set: TabSet) {
  return set.list.find((tab) => tab.key === set.active) ?? set.list[0];
}

export function tabPage(tab: Tab) {
  return tab.trail[tab.cursor] ?? null;
}

function replaceActive(set: TabSet, tab: Tab): TabSet {
  return {
    ...set,
    list: set.list.map((item) => (item.key === tab.key ? tab : item)),
  };
}

export function visit(set: TabSet, page: string | null): TabSet {
  const tab = activeTab(set);

  if (tabPage(tab) === page) return set;
  const trail = [...tab.trail.slice(0, tab.cursor + 1), page].slice(
    -TRAIL_LENGTH,
  );

  return replaceActive(set, { ...tab, trail, cursor: trail.length - 1 });
}

export function moveInHistory(set: TabSet, delta: number): TabSet | null {
  const tab = activeTab(set);
  const cursor = tab.cursor + delta;

  if (cursor < 0 || cursor >= tab.trail.length) return null;

  return replaceActive(set, { ...tab, cursor });
}

export function addTab(set: TabSet, page: string | null): TabSet | null {
  if (set.list.length >= TAB_LIMIT) return null;
  const tab = newTab(page);
  const index = set.list.findIndex((item) => item.key === set.active);
  const list = [...set.list];

  list.splice(index + 1, 0, tab);

  return { list, active: tab.key };
}

export function closeTab(set: TabSet, key: string): TabSet | null {
  const index = set.list.findIndex((tab) => tab.key === key);

  if (index === -1 || set.list.length < 2) return null;
  const list = set.list.filter((tab) => tab.key !== key);

  if (key !== set.active) return { ...set, list };

  return { list, active: list[Math.min(index, list.length - 1)].key };
}

export function selectTab(set: TabSet, key: string): TabSet | null {
  if (key === set.active || !set.list.some((tab) => tab.key === key))
    return null;

  return { ...set, active: key };
}

export function cycleTab(set: TabSet, delta: number): TabSet | null {
  if (set.list.length < 2) return null;
  const index = set.list.findIndex((tab) => tab.key === set.active);
  const next = (index + delta + set.list.length) % set.list.length;

  return { ...set, active: set.list[next].key };
}

export function moveTab(
  set: TabSet,
  key: string,
  target: string,
): TabSet | null {
  const from = set.list.findIndex((tab) => tab.key === key);
  const to = set.list.findIndex((tab) => tab.key === target);

  if (from === -1 || to === -1 || from === to) return null;
  const list = [...set.list];
  const [tab] = list.splice(from, 1);

  list.splice(to, 0, tab);

  return { ...set, list };
}

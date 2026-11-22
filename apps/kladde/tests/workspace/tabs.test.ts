import { describe, expect, it } from "vitest";
import {
  activeTab,
  addTab,
  closeTab,
  cycleTab,
  moveInHistory,
  moveTab,
  selectTab,
  startTabs,
  tabPage,
  visit,
  type TabSet,
} from "../../src/workspace/tabs";

const TAB_LIMIT = 30;
const TRAIL_LENGTH = 100;

function tabsWith(count: number) {
  let set = startTabs();

  for (let i = 1; i < count; i++) set = addTab(set, `p${i}`)!;

  return set;
}

function keys(set: TabSet) {
  return set.list.map((tab) => tab.key);
}

describe("tab history", () => {
  it("starts with one empty tab that is active", () => {
    const set = startTabs();

    expect(set.list).toHaveLength(1);
    expect(set.active).toBe(set.list[0].key);
    expect(tabPage(activeTab(set))).toBeNull();
  });

  it("drops the forward history when a new page is visited after going back", () => {
    let set = visit(visit(startTabs(), "a"), "b");

    set = moveInHistory(set, -1)!;
    expect(tabPage(activeTab(set))).toBe("a");
    set = visit(set, "c");
    expect(activeTab(set).trail).toEqual([null, "a", "c"]);
    expect(moveInHistory(set, 1)).toBeNull();
  });

  it("returns the same set when the current page is visited again", () => {
    const set = visit(startTabs(), "a");

    expect(visit(set, "a")).toBe(set);
  });

  it("keeps only the most recent pages and points at the last one", () => {
    let set = startTabs();

    for (let i = 0; i < TRAIL_LENGTH + 20; i++) set = visit(set, `p${i}`);
    const tab = activeTab(set);

    expect(tab.trail).toHaveLength(TRAIL_LENGTH);
    expect(tab.cursor).toBe(TRAIL_LENGTH - 1);
    expect(tabPage(tab)).toBe(`p${TRAIL_LENGTH + 19}`);
    expect(tab.trail[0]).toBe("p20");
  });

  it("refuses to move before the first or past the last entry", () => {
    const set = visit(startTabs(), "a");

    expect(moveInHistory(set, -2)).toBeNull();
    expect(moveInHistory(set, 1)).toBeNull();
    expect(tabPage(activeTab(moveInHistory(set, -1)!))).toBeNull();
  });
});

describe("tab list", () => {
  it("opens a new tab right after the active one and activates it", () => {
    const set = tabsWith(3);
    const first = set.list[0].key;
    const opened = addTab(selectTab(set, first)!, "new")!;

    expect(keys(opened).indexOf(opened.active)).toBe(1);
    expect(tabPage(activeTab(opened))).toBe("new");
    expect(opened.list).toHaveLength(4);
  });

  it("stops opening tabs at the limit", () => {
    const full = tabsWith(TAB_LIMIT);

    expect(full.list).toHaveLength(TAB_LIMIT);
    expect(addTab(full, "more")).toBeNull();
  });

  it("never closes the last tab or an unknown one", () => {
    const set = startTabs();

    expect(closeTab(set, set.active)).toBeNull();
    expect(closeTab(tabsWith(2), "missing")).toBeNull();
  });

  it("activates the right neighbour after closing the active tab, or the left one at the end", () => {
    const set = tabsWith(3);
    const [a, b, c] = keys(set);
    const middle = closeTab(selectTab(set, b)!, b)!;

    expect(middle.active).toBe(c);
    const last = closeTab(set, c)!;

    expect(last.active).toBe(b);
    expect(keys(last)).toEqual([a, b]);
  });

  it("keeps the active tab when another tab is closed", () => {
    const set = tabsWith(3);
    const closed = closeTab(set, set.list[0].key)!;

    expect(closed.active).toBe(set.active);
    expect(closed.list).toHaveLength(2);
  });

  it("ignores selecting the active or an unknown tab", () => {
    const set = tabsWith(2);

    expect(selectTab(set, set.active)).toBeNull();
    expect(selectTab(set, "missing")).toBeNull();
  });

  it("cycles through tabs in both directions with wrap-around", () => {
    const set = tabsWith(3);
    const [a, , c] = keys(set);
    const atFirst = selectTab(set, a)!;

    expect(cycleTab(atFirst, -1)!.active).toBe(c);
    expect(set.active).toBe(c);
    expect(cycleTab(set, 1)!.active).toBe(a);
    expect(cycleTab(startTabs(), 1)).toBeNull();
  });

  it("reorders tabs without losing or duplicating any", () => {
    const set = tabsWith(4);
    const [a, b, c, d] = keys(set);
    const moved = moveTab(set, a, c)!;

    expect(keys(moved)).toEqual([b, c, a, d]);
    expect(keys(moveTab(moved, a, b)!)).toEqual([a, b, c, d]);
    expect(moved.active).toBe(set.active);
    expect(moveTab(set, a, a)).toBeNull();
    expect(moveTab(set, a, "missing")).toBeNull();
  });

  it("falls back to the first tab when the active key is stale", () => {
    const set = tabsWith(2);

    expect(activeTab({ ...set, active: "gone" })).toBe(set.list[0]);
  });
});

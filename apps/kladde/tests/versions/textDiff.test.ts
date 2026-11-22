import { expect, test } from "vitest";
import { diffWords, type DiffPart } from "../../src/versions/textDiff";

function text(parts: DiffPart[], dropped: DiffPart["kind"]) {
  return parts
    .filter((part) => part.kind !== dropped)
    .map((part) => part.text)
    .join("");
}

function marked(parts: DiffPart[]) {
  const marks = { same: "", removed: "-", added: "+" };

  return parts.map((part) => marks[part.kind] + part.text);
}

test("unchanged text is a single part", () => {
  expect(diffWords("gleich geblieben", "gleich geblieben")).toEqual([
    { kind: "same", text: "gleich geblieben" },
  ]);
  expect(diffWords("", "")).toEqual([]);
});

test("a replaced word is marked without touching its neighbours", () => {
  const parts = diffWords("Der Bericht ist offen.", "Der Bericht ist fertig.");

  expect(marked(parts)).toEqual(["Der Bericht ist ", "-offen", "+fertig", "."]);
});

test("a rewritten phrase reads as one removal and one addition", () => {
  const parts = diffWords(
    "Wir treffen uns am Montag im Büro.",
    "Wir treffen uns nächsten Freitag online.",
  );

  expect(marked(parts)).toEqual([
    "Wir treffen uns ",
    "-am Montag im Büro",
    "+nächsten Freitag online",
    ".",
  ]);
});

test("added and removed text appear on their own", () => {
  expect(marked(diffWords("eins", "eins zwei"))).toEqual(["eins", "+ zwei"]);
  expect(marked(diffWords("eins zwei", "zwei"))).toEqual(["-eins ", "zwei"]);
  expect(marked(diffWords("", "neu"))).toEqual(["+neu"]);
  expect(marked(diffWords("alt", ""))).toEqual(["-alt"]);
});

test("both sides can be rebuilt from the parts", () => {
  const before = "# Plan\n\n- Äpfel kaufen\n- Brot (2×) holen\n\nBis morgen!";
  const after = "# Plan B\n\n- Brot (3×) holen\n- Käse\n\nBis übermorgen!";
  const parts = diffWords(before, after);

  expect(text(parts, "added")).toBe(before);
  expect(text(parts, "removed")).toBe(after);
});

test("very large rewrites fall back to whole blocks", () => {
  const before = Array(3000).fill("a").join(" ");
  const after = Array(3000).fill("b").join(" ");
  const parts = diffWords(before, after);

  expect(parts.map((part) => part.kind)).toEqual(["removed", "added"]);
  expect(parts[0].text === before && parts[1].text === after).toBe(true);
});

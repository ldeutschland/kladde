import { describe, expect, it } from "vitest";
import {
  emojiIcon,
  markCallouts,
  styleCallouts,
} from "../../src/notebook/pageMarkdown";

type Blocks = Parameters<typeof styleCallouts>[0];
interface Sketch {
  type: string;
  text: string;
  color?: string;
  children?: Sketch[];
}

const bold = { type: "text", text: "wichtig", styles: { bold: true } };

function block(sketch: Sketch): Blocks[number] {
  return {
    id: sketch.text,
    type: sketch.type,
    props: { backgroundColor: sketch.color ?? "default" },
    content: [{ type: "text", text: sketch.text, styles: {} }, bold],
    children: (sketch.children ?? []).map(block),
  } as unknown as Blocks[number];
}

function look(blocks: Blocks): unknown[] {
  return blocks.map((item) => {
    const content = item.content as { text: string }[];
    const props = item.props as { backgroundColor: string };
    const text = content.map((part) => part.text).join("|");
    const children = look(item.children as Blocks);

    return [props.backgroundColor, text, ...children];
  });
}

describe("Callouts in agent Markdown", () => {
  it("turns marked quotes into coloured callouts", () => {
    const styled = styleCallouts([
      block({ type: "quote", text: "[!NOTE]\n Mehrzeilig" }),
      block({ type: "quote", text: "[!tip] Klein geschrieben" }),
      block({ type: "quote", text: "[!IMPORTANT]" }),
      block({ type: "quote", text: "[!WARNING]   Abstand" }),
      block({ type: "quote", text: "[!CAUTION] Rot" }),
    ]);

    expect(look(styled)).toEqual([
      ["blue", "ℹ️ Mehrzeilig|wichtig"],
      ["green", "💡 Klein geschrieben|wichtig"],
      ["purple", "📌 |wichtig"],
      ["yellow", "⚠️ Abstand|wichtig"],
      ["red", "🚨 Rot|wichtig"],
    ]);
  });

  it("leaves other quotes, unknown markers and other blocks alone", () => {
    const plain = [
      block({ type: "quote", text: "Nur ein Zitat" }),
      block({ type: "quote", text: "[!FOO] Unbekannt" }),
      block({ type: "quote", text: "Später [!NOTE] im Text" }),
      block({ type: "paragraph", text: "[!NOTE] Kein Zitat" }),
    ];

    expect(look(styleCallouts(plain))).toEqual(look(plain));
  });

  it("styles callouts inside lists and toggles", () => {
    const nested = block({
      type: "toggleListItem",
      text: "Mehr",
      children: [{ type: "quote", text: "[!TIP] Innen" }],
    });

    expect(look(styleCallouts([nested]))).toEqual([
      ["default", "Mehr|wichtig", ["green", "💡 Innen|wichtig"]],
    ]);
  });

  it("writes callouts back with their marker for the agent", () => {
    const [styled] = styleCallouts([
      block({
        type: "bulletListItem",
        text: "Punkt",
        children: [{ type: "quote", text: "[!WARNING] Achtung" }],
      }),
    ]);

    expect(look([markCallouts(styled)])).toEqual([
      ["default", "Punkt|wichtig", ["yellow", "[!WARNING] Achtung|wichtig"]],
    ]);
  });

  it("does not mark quotes the user coloured or wrote by hand", () => {
    const own = [
      block({ type: "quote", text: "💡 Ohne Farbe" }),
      block({ type: "quote", text: "Farbig ohne Symbol", color: "green" }),
      block({ type: "quote", text: "💡 Andere Farbe", color: "red" }),
      block({ type: "paragraph", text: "💡 Absatz", color: "green" }),
    ];

    expect(look(own.map(markCallouts))).toEqual(look(own));
  });
});

describe("Page icons from the agent", () => {
  it("accepts one emoji, also joined ones and flags", () => {
    for (const icon of ["🧳", "👨‍👩‍👧", "🇩🇪", "✈️", "👍🏽"])
      expect(emojiIcon(icon)).toBe(icon);
    expect(emojiIcon("  📅 ")).toBe("📅");
  });

  it("rejects text, markup, several words and other values", () => {
    const invalid = [
      "",
      " ",
      "calendar",
      "📅 Plan",
      "<b>",
      "1",
      "a📅",
      7,
      null,
    ];

    for (const icon of invalid)
      expect(() => emojiIcon(icon), String(icon)).toThrow(/single emoji/);
    expect(() => emojiIcon("🧳".repeat(9))).toThrow(/single emoji/);
  });
});

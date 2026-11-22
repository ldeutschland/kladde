import { describe, expect, it } from "vitest";
import {
  ACTION_ICONS,
  EDIT_ACTIONS,
  INSTRUCTIONS,
  INSTRUCTION_LENGTH,
  PREFILLS,
  WRITE_ACTIONS,
} from "../../src/inlineAi/actions";
import { translator } from "../../src/locale/locale";

describe("Inline AI actions", () => {
  it("gives every menu entry an icon and exactly one way to run", () => {
    for (const word of [...EDIT_ACTIONS, ...WRITE_ACTIONS]) {
      expect(ACTION_ICONS[word], word).toBeDefined();
      expect(!!INSTRUCTIONS[word] !== !!PREFILLS[word], word).toBe(true);
    }
  });

  it("keeps built-in instructions within the instruction limit", () => {
    for (const instruction of Object.values(INSTRUCTIONS))
      expect(instruction!.length).toBeLessThanOrEqual(INSTRUCTION_LENGTH);
  });

  it("shows distinct labels within each menu in both languages", () => {
    for (const lang of ["de", "en"]) {
      const t = translator(lang);

      for (const menu of [EDIT_ACTIONS, WRITE_ACTIONS]) {
        const labels = menu.map((word) => t(word).toLowerCase());

        expect(new Set(labels).size, lang).toBe(labels.length);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { pagesLinkedIn } from "../../src/notebook/links";

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

describe("page links", () => {
  it("keeps at most as many distinct links as the store accepts", () => {
    const text = Array.from({ length: 5000 }, (_, n) => `kladde:${id(n)}`)
      .concat(`kladde:${id(1)}`)
      .join(" ");
    const links = pagesLinkedIn(text);

    expect(links).toHaveLength(4096);
    expect(new Set(links).size).toBe(4096);
    expect(links[0]).toBe(id(0));
  });
});

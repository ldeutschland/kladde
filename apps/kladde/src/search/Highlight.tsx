import { searchTerms } from "./search";

function termPattern(query: string) {
  const terms = searchTerms(query)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  return terms.length ? new RegExp(`(${terms.join("|")})`, "giu") : null;
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const pattern = termPattern(query);

  if (!pattern) return text;

  return text
    .split(pattern)
    .map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part));
}

const PAGE_LINK =
  /^kladde:(?:\/\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const WEB_LINK = /^(?:https?:\/\/[^\s]+|mailto:[^\s]+)$/i;
const STORABLE_PAGE_LINKS =
  /kladde:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})/g;
const MAX_STORED_LINKS = 4096;

export function pageLink(id: string) {
  return "kladde:" + id;
}

export function linkedPage(href: string) {
  return PAGE_LINK.exec(href.trim())?.[1].toLowerCase() ?? null;
}

export function pagesLinkedIn(text: string) {
  const ids = Array.from(text.matchAll(STORABLE_PAGE_LINKS), (m) => m[1]);

  return [...new Set(ids)].slice(0, MAX_STORED_LINKS);
}

export function isValidLink(href: string) {
  return linkedPage(href) !== null || WEB_LINK.test(href.trim());
}

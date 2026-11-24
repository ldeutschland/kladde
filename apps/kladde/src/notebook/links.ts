const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAGE_ID = new RegExp(`^${UUID}$`, "i");
const PAGE_LINK = new RegExp(`^kladde:(?:\\/\\/)?(${UUID})\\/?$`, "i");
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

export function pageIdOf(value: string) {
  return PAGE_ID.test(value) ? value.toLowerCase() : null;
}

export function pagesLinkedIn(text: string) {
  const ids = Array.from(text.matchAll(STORABLE_PAGE_LINKS), (m) => m[1]);

  return [...new Set(ids)].slice(0, MAX_STORED_LINKS);
}

export function webLink(href: string) {
  const address = href.trim();

  return WEB_LINK.test(address) ? address : null;
}

export function isValidLink(href: string) {
  return linkedPage(href) !== null || webLink(href) !== null;
}

import { linkedPage, webLink } from "../notebook/links";
import { command } from "../platform/native";
import type { PageLinkContext } from "./pageLinkSpec";

export type LinkOpener = Required<PageLinkContext>;

export function opensLinks(
  context: PageLinkContext | undefined,
): context is LinkOpener {
  return !!context?.open && !!context.notify;
}

function openPage(opener: LinkOpener, id: string, inNewTab: boolean) {
  const { book, t, notify } = opener;
  const page = book.pages.get(id);

  if (!page || page.kind === "chat") return notify(t("pageUnavailable"));
  if (page.archived) return notify(t("pageTrashed"));
  opener.open(id, inNewTab);
}

function openAddress(opener: LinkOpener, address: string) {
  void command("open_web_source", { address }).catch(() =>
    opener.notify(opener.t("linkFailed")),
  );
}

export function openLink(opener: LinkOpener, href: string, inNewTab = false) {
  const page = linkedPage(href);

  if (page) return openPage(opener, page, inNewTab);
  const address = webLink(href);

  if (address) openAddress(opener, address);
}
